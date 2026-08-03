import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, ReservationStatus, RoomStatus, type Property } from '@prisma/client';
import type { AuthUser } from '../auth/auth.constants';
import { PrismaService } from '../prisma/prisma.service';
import { resolvePropertyScope } from '../properties/property-scope';
import { formatDateOnly, parseDateOnly } from '../sync/reservation.mapper';
import type { DailyReportDto } from './dto/reports.dto';

/** 조회 가능한 최대 기간. 넓히면 한 번에 읽는 예약 수가 감당하기 어려워진다. */
const MAX_DAYS = 92;

/**
 * 실적이 잡히는 예약 상태.
 *
 * 취소·노쇼·대기는 뺀다 — 그날 실제로 방을 쓴 예약만 점유율에 들어가야 한다.
 * 아직 도착하지 않은 예약(RESERVED·CONFIRMED)도 미래 날짜에서는 실적이 아니라
 * 예약분이므로 따로 센다.
 */
const REALIZED: ReservationStatus[] = [ReservationStatus.IN_HOUSE, ReservationStatus.CHECKED_OUT];

const BOOKED: ReservationStatus[] = [ReservationStatus.RESERVED, ReservationStatus.CONFIRMED];

/** 판매할 수 없는 객실 상태. 분모에서 뺀다. */
const UNSELLABLE: RoomStatus[] = [RoomStatus.OUT_OF_ORDER, RoomStatus.OUT_OF_SERVICE];

export interface DailyRow {
  date: string;
  roomsAvailable: number;
  roomsSold: number;
  roomsBooked: number;
  occupancy: number;
  roomRevenue: string;
  adr: string;
  revpar: string;
}

/**
 * 영업 실적.
 *
 * 두 가지 매출을 분명히 나눠 둔다.
 *
 * - **객실 매출(계약 기준)**: 예약의 총액을 박수로 나눠 각 날짜에 배분한 값.
 *   OPERA 가 확정한 금액이라 모든 예약에 있고, 점유율·ADR·RevPAR 의 근거가 된다.
 * - **포스팅 매출(실제 청구)**: 폴리오에 올라간 청구·결제. 체크인 이후에만 생긴다.
 *
 * 둘을 섞으면 "매출이 왜 다른가" 를 아무도 설명할 수 없게 된다. 정산 대사에는
 * 포스팅을, 판매 지표에는 계약 기준을 쓴다.
 *
 * 이 숫자는 로컬 사본에서 계산한 값이다. 회계 마감에 쓰는 공식 수치는 OPERA 의
 * 리포트를 따라야 한다 — 여기 값은 운영 판단을 위한 것이다.
 */
@Injectable()
export class ReportsService {
  constructor(private readonly prisma: PrismaService) {}

  async daily(query: DailyReportDto, user: AuthUser) {
    const property = await this.resolveProperty(query.propertyId, user);
    const dates = this.expandRange(query.from, query.to);

    const from = parseDateOnly(dates[0]!);
    const toExclusive = parseDateOnly(dates[dates.length - 1]!);

    const [rooms, reservations, postings] = await Promise.all([
      this.prisma.room.findMany({
        where: { propertyId: property.id },
        select: { status: true },
      }),
      // 기간과 겹치는 예약만 읽는다. 도착이 기간 뒤이거나 출발이 기간 앞이면 무관하다.
      this.prisma.reservation.findMany({
        where: {
          propertyId: property.id,
          status: { in: [...REALIZED, ...BOOKED] },
          arrivalDate: { lte: toExclusive },
          departureDate: { gt: from },
        },
        select: {
          status: true,
          arrivalDate: true,
          departureDate: true,
          totalAmount: true,
        },
      }),
      this.prisma.posting.findMany({
        where: {
          folio: { reservation: { propertyId: property.id } },
          postedAt: { gte: from, lt: addDays(toExclusive, 1) },
        },
        select: { type: true, amount: true, postedAt: true },
      }),
    ]);

    /**
     * 분모는 현재 판매 가능한 객실 수다.
     *
     * 과거 날짜의 고장 이력은 남기지 않으므로 그 시점의 실제 가용 객실과는 다를 수
     * 있다. 화면에 이 사실을 함께 표시한다 — 근거를 모르는 지표는 잘못 쓰인다.
     */
    const roomsAvailable = rooms.filter((room) => !UNSELLABLE.includes(room.status)).length;

    const rows: DailyRow[] = dates.map((date) => {
      const stays = reservations.filter((r) => coversNight(r, date));
      const sold = stays.filter((r) => REALIZED.includes(r.status));
      const booked = stays.filter((r) => BOOKED.includes(r.status));

      // 총액을 박수로 나눠 그날 몫만 더한다. 나누어떨어지지 않는 끝자리는
      // 날짜별로 흩어지지만 기간 합계는 총액과 어긋나지 않는다.
      const revenue = sold.reduce(
        (sum, r) => sum.add(nightlyShare(r.totalAmount, r.arrivalDate, r.departureDate)),
        new Prisma.Decimal(0),
      );

      return {
        date,
        roomsAvailable,
        roomsSold: sold.length,
        roomsBooked: booked.length,
        occupancy: roomsAvailable === 0 ? 0 : round(sold.length / roomsAvailable, 4),
        roomRevenue: revenue.toFixed(2),
        adr: sold.length === 0 ? '0.00' : revenue.div(sold.length).toFixed(2),
        revpar: roomsAvailable === 0 ? '0.00' : revenue.div(roomsAvailable).toFixed(2),
      };
    });

    const totalRevenue = rows.reduce((sum, row) => sum.add(row.roomRevenue), new Prisma.Decimal(0));
    const totalSold = rows.reduce((sum, row) => sum + row.roomsSold, 0);
    const totalAvailable = roomsAvailable * rows.length;

    const charges = sumBy(postings, (p) => p.type === 'CHARGE' || p.type === 'TAX');
    const payments = sumBy(postings, (p) => p.type === 'PAYMENT');
    const adjustments = sumBy(postings, (p) => p.type === 'ADJUSTMENT');

    return {
      propertyId: property.id,
      currency: property.currency,
      from: dates[0],
      to: dates[dates.length - 1],
      nights: rows.length,
      roomsAvailable,
      /** 근거를 함께 내린다. 지표만 보면 분모가 무엇인지 알 수 없다. */
      basis: '판매 가능 객실은 현재 고장·판매중지가 아닌 객실 수입니다.',
      totals: {
        roomsSold: totalSold,
        roomsAvailable: totalAvailable,
        occupancy: totalAvailable === 0 ? 0 : round(totalSold / totalAvailable, 4),
        roomRevenue: totalRevenue.toFixed(2),
        adr: totalSold === 0 ? '0.00' : totalRevenue.div(totalSold).toFixed(2),
        revpar: totalAvailable === 0 ? '0.00' : totalRevenue.div(totalAvailable).toFixed(2),
      },
      /**
       * 폴리오에 실제로 올라간 금액. 계약 기준 매출과 다른 값이다.
       *
       * `amount` 는 저장 시점에 이미 부호가 붙어 있다(결제·차감 조정은 음수).
       * 미수는 그래서 단순 합계다 — 결제를 한 번 더 빼면 두 번 빠진다.
       */
      postings: {
        charges: charges.toFixed(2),
        payments: payments.toFixed(2),
        adjustments: adjustments.toFixed(2),
        outstanding: charges.add(payments).add(adjustments).toFixed(2),
      },
      rows,
    };
  }

  // ---------------------------------------------------------------------------

  /** 기간을 날짜 배열로 편다. 뒤집힌 범위와 지나치게 넓은 범위는 여기서 막는다. */
  private expandRange(from: string, to: string): string[] {
    if (to < from) {
      throw new BadRequestException('종료일은 시작일보다 뒤여야 합니다.');
    }

    const dates: string[] = [];
    for (let cursor = from; cursor <= to; cursor = addDaysString(cursor, 1)) {
      dates.push(cursor);
      if (dates.length > MAX_DAYS) {
        throw new BadRequestException(`조회 기간은 최대 ${MAX_DAYS}일입니다.`);
      }
    }
    return dates;
  }

  private async resolveProperty(requested: string | undefined, user: AuthUser): Promise<Property> {
    const propertyId = resolvePropertyScope(user, requested);
    if (!propertyId) {
      throw new BadRequestException('호텔을 선택해 주세요.');
    }

    const property = await this.prisma.property.findUnique({ where: { id: propertyId } });
    if (!property) {
      throw new NotFoundException(`호텔을 찾을 수 없습니다: ${propertyId}`);
    }
    return property;
  }
}

/** 그 날짜에 숙박했는지. 출발일 당일은 방을 쓰지 않으므로 제외한다. */
function coversNight(
  reservation: { arrivalDate: Date; departureDate: Date },
  date: string,
): boolean {
  const arrival = formatDateOnly(reservation.arrivalDate);
  const departure = formatDateOnly(reservation.departureDate);
  return arrival <= date && date < departure;
}

function nightlyShare(
  total: Prisma.Decimal | null,
  arrival: Date,
  departure: Date,
): Prisma.Decimal {
  if (!total) return new Prisma.Decimal(0);
  const nights = Math.max(1, Math.round((departure.getTime() - arrival.getTime()) / 86_400_000));
  return total.div(nights);
}

function sumBy<T extends { amount: Prisma.Decimal }>(
  items: T[],
  predicate: (item: T) => boolean,
): Prisma.Decimal {
  return items.filter(predicate).reduce((sum, item) => sum.add(item.amount), new Prisma.Decimal(0));
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function addDaysString(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}
