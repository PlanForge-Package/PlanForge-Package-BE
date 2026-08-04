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

/** Longest queryable range. Any wider and one read pulls too many reservations. */
const MAX_DAYS = 92;

/**
 * Reservation statuses that count towards performance.
 *
 * Cancelled, no-show and waitlisted are excluded — only reservations that used a
 * room that day belong in occupancy. Not-yet-arrived bookings (RESERVED,
 * CONFIRMED) are counted separately, as on future dates they are on the books.
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
 * Business performance.
 *
 * Two kinds of revenue are kept apart.
 *
 * - **Room revenue (contracted)**: the reservation total split across its nights.
 *   OPERA confirmed it, so every reservation has it; occupancy, ADR and RevPAR use it.
 * - **Posted revenue (actually charged)**: folio charges and payments, from check-in on.
 *
 * Mixed together, nobody can explain why the revenue differs. Reconciliation uses
 * posted revenue, sales metrics use contracted revenue.
 *
 * These numbers come from the local copy. Official figures for accounting close
 * must follow OPERA's reports — these are for operational judgement.
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
      // Only reservations overlapping the range. Arriving after or leaving before is irrelevant.
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
       * Out-of-order rooms, removed from the denominator.
       *
       * Only OutOfOrder is read. OutOfService is merely not for sale and stays in
       * inventory, so the denominator holds — that difference is why they are split.
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
     * The denominator is how many rooms were sellable on that date.
     *
     * Outages carry dates, so past days use the rooms available then. A room left
     * merely flagged out of order has no start date, so it is subtracted only from
     * today onwards.
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

      // Divide the total by nights and add only that day's share. The remainder
      // scatters across dates but the range total still matches the reservation.
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
    // Available rooms differ per date, so the total sums per-date values. Multiplying
    // one day inflates the denominator across an outage and understates occupancy.
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
      /** The inputs come with it. From the metric alone the denominator is invisible. */
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
       * Breakdown by channel, source and market.
       *
       * Without knowing what each origin leaves behind, a channel that keeps
       * selling at a loss stays hidden. These must sum to the totals above.
       */
      breakdown: {
        channel: groupBy(dates, reservations, (r) => r.channelCode),
        source: groupBy(dates, reservations, (r) => r.sourceCode),
        market: groupBy(dates, reservations, (r) => r.marketCode),
      },
      /**
       * What actually posted to the folio. Different from contracted revenue.
       *
       * `amount` is already signed when stored (payments and credits negative).
       * Outstanding is therefore a plain sum — subtracting payments again doubles them.
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

  /** Expands a range into dates. Reversed and overly wide ranges are rejected here. */
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
  /** This bucket's share of total sales. Channel dependence at a glance. */
  share: number;
}

/**
 * Performance by bucket.
 *
 * Reservations with no code are grouped as "(unspecified)". Dropped instead, the
 * breakdown would not sum to the total and neither figure could be trusted.
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
      // Largest revenue first. Channel dependence reads naturally from the top.
      .sort((a, b) => Number(b.roomRevenue) - Number(a.roomRevenue))
  );
}

/** Whether the stay covers that date. The departure day uses no room, so it is excluded. */
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
