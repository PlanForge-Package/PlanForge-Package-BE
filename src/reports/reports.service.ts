import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import {
  Prisma,
  ReservationStatus,
  RoomOutageKind,
  RoomStatus,
  type Property,
} from '@prisma/client';
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

    const [rooms, reservations, postings, outages] = await Promise.all([
      this.prisma.room.findMany({
        where: { propertyId: property.id },
        select: { id: true, status: true },
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
          sourceCode: true,
          marketCode: true,
          channelCode: true,
        },
      }),
      this.prisma.posting.findMany({
        where: {
          folio: { reservation: { propertyId: property.id } },
          postedAt: { gte: from, lt: addDays(toExclusive, 1) },
        },
        select: { type: true, amount: true, postedAt: true },
      }),
      /*
       * 분모에서 뺄 고장 객실.
       *
       * OutOfOrder 만 읽는다. OutOfService 는 팔지 않을 뿐 재고에는 남아 있어
       * 분모가 줄지 않는다 — 그 차이가 두 구분을 나눠 둔 이유다.
       */
      this.prisma.roomOutage.findMany({
        where: {
          propertyId: property.id,
          kind: RoomOutageKind.OUT_OF_ORDER,
          startDate: { lte: toExclusive },
          endDate: { gte: from },
        },
        select: { roomId: true, startDate: true, endDate: true, releasedAt: true },
      }),
    ]);

    /**
     * 분모는 그 날짜에 팔 수 있었던 객실 수다.
     *
     * 기간 기록이 있으므로 지난 날짜도 그때의 가용 객실로 계산한다. 다만 기간
     * 없이 상태만 고장으로 바꿔 둔 객실은 언제부터인지 알 수 없어, 오늘 이후
     * 날짜에서만 뺀다.
     */
    const today = formatDateOnly(new Date());
    const statusOnlyBroken = rooms
      .filter((room) => room.status === RoomStatus.OUT_OF_ORDER)
      .map((room) => room.id);

    const availableOn = (date: string): number => {
      const broken = new Set<string>();
      for (const outage of outages) {
        const releasedOn = outage.releasedAt ? formatDateOnly(outage.releasedAt) : undefined;
        const stillOut = !releasedOn || date < releasedOn;
        if (
          stillOut &&
          formatDateOnly(outage.startDate) <= date &&
          formatDateOnly(outage.endDate) >= date
        ) {
          broken.add(outage.roomId);
        }
      }
      if (date >= today) {
        for (const roomId of statusOnlyBroken) broken.add(roomId);
      }
      return Math.max(0, rooms.length - broken.size);
    };

    const rows: DailyRow[] = dates.map((date) => {
      const roomsAvailable = availableOn(date);
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
    // 날짜마다 가용 객실이 다르므로 합계도 날짜별 값을 더한다. 하루치를 곱하면
    // 공사 기간이 들어간 구간에서 분모가 부풀어 점유율이 낮게 나온다.
    const totalAvailable = rows.reduce((sum, row) => sum + row.roomsAvailable, 0);

    const charges = sumBy(postings, (p) => p.type === 'CHARGE' || p.type === 'TAX');
    const payments = sumBy(postings, (p) => p.type === 'PAYMENT');
    const adjustments = sumBy(postings, (p) => p.type === 'ADJUSTMENT');

    return {
      propertyId: property.id,
      currency: property.currency,
      from: dates[0],
      to: dates[dates.length - 1],
      nights: rows.length,
      roomsAvailable: availableOn(dates[dates.length - 1]!),
      /** 근거를 함께 내린다. 지표만 보면 분모가 무엇인지 알 수 없다. */
      basis:
        '판매 가능 객실은 전체 객실에서 그 날짜에 고장(OOO)인 객실을 뺀 수입니다. 판매중지(OOS)는 재고에 남아 분모에서 빠지지 않습니다.',
      totals: {
        roomsSold: totalSold,
        roomsAvailable: totalAvailable,
        occupancy: totalAvailable === 0 ? 0 : round(totalSold / totalAvailable, 4),
        roomRevenue: totalRevenue.toFixed(2),
        adr: totalSold === 0 ? '0.00' : totalRevenue.div(totalSold).toFixed(2),
        revpar: totalAvailable === 0 ? '0.00' : totalRevenue.div(totalAvailable).toFixed(2),
      },
      /**
       * 채널·출처·시장별 분해.
       *
       * 어디서 들어온 예약이 얼마를 남기는지 모르면 수수료를 물고도 계속 파는
       * 채널을 골라낼 수 없다. 합계는 위의 totals 와 같아야 한다.
       */
      breakdown: {
        channel: groupBy(dates, reservations, (r) => r.channelCode),
        source: groupBy(dates, reservations, (r) => r.sourceCode),
        market: groupBy(dates, reservations, (r) => r.marketCode),
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

interface StayRow {
  status: ReservationStatus;
  arrivalDate: Date;
  departureDate: Date;
  totalAmount: Prisma.Decimal | null;
}

export interface BreakdownRow {
  code: string;
  roomsSold: number;
  roomRevenue: string;
  adr: string;
  /** 이 분류가 전체 판매에서 차지하는 비중. 채널 의존도를 한눈에 본다. */
  share: number;
}

/**
 * 분류별 실적.
 *
 * 코드가 비어 있는 예약은 '(미지정)' 으로 모은다. 빼 버리면 분해 합계가 전체와
 * 어긋나 어느 쪽이 맞는지 알 수 없게 된다.
 */
function groupBy(
  dates: string[],
  reservations: Array<StayRow & Record<string, unknown>>,
  pick: (row: Record<string, unknown>) => unknown,
): BreakdownRow[] {
  const buckets = new Map<string, { roomsSold: number; revenue: Prisma.Decimal }>();

  for (const date of dates) {
    for (const stay of reservations) {
      if (!REALIZED.includes(stay.status) || !coversNight(stay, date)) continue;

      const raw = pick(stay);
      const code = typeof raw === 'string' && raw ? raw : '(미지정)';
      const bucket = buckets.get(code) ?? { roomsSold: 0, revenue: new Prisma.Decimal(0) };
      bucket.roomsSold += 1;
      bucket.revenue = bucket.revenue.add(
        nightlyShare(stay.totalAmount, stay.arrivalDate, stay.departureDate),
      );
      buckets.set(code, bucket);
    }
  }

  const totalSold = [...buckets.values()].reduce((sum, b) => sum + b.roomsSold, 0);

  return (
    [...buckets.entries()]
      .map(([code, bucket]) => ({
        code,
        roomsSold: bucket.roomsSold,
        roomRevenue: bucket.revenue.toFixed(2),
        adr: bucket.roomsSold === 0 ? '0.00' : bucket.revenue.div(bucket.roomsSold).toFixed(2),
        share: totalSold === 0 ? 0 : round(bucket.roomsSold / totalSold, 4),
      }))
      // 매출이 큰 쪽부터. 채널 의존도는 위에서부터 읽는 것이 자연스럽다.
      .sort((a, b) => Number(b.roomRevenue) - Number(a.roomRevenue))
  );
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
