import { ReservationStatus } from '@prisma/client';
import type { CoreReservationStatus } from '../core/core.types';

/** Core (OPERA terms) to PlanForge reservation status. */
const STATUS_MAP: Record<CoreReservationStatus, ReservationStatus> = {
  Reserved: ReservationStatus.RESERVED,
  Confirmed: ReservationStatus.CONFIRMED,
  InHouse: ReservationStatus.IN_HOUSE,
  CheckedOut: ReservationStatus.CHECKED_OUT,
  Cancelled: ReservationStatus.CANCELLED,
  NoShow: ReservationStatus.NO_SHOW,
  Waitlisted: ReservationStatus.WAITLISTED,
};

export function toReservationStatus(status: string): ReservationStatus {
  return STATUS_MAP[status as CoreReservationStatus] ?? ReservationStatus.RESERVED;
}

/** PlanForge to Core (OPERA terms). Used for reverse query filters. */
export function toCoreStatus(status: ReservationStatus): CoreReservationStatus | undefined {
  const entry = Object.entries(STATUS_MAP).find(([, value]) => value === status);
  return entry?.[0] as CoreReservationStatus | undefined;
}

/**
 * Turns `YYYY-MM-DD` into a Date.
 *
 * Prisma `@db.Date` columns store UTC midnight, so parsing is forced to UTC to stop
 * the date shifting a day when the local zone is behind UTC.
 */
export function parseDateOnly(value: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!match) {
    throw new Error(`날짜 형식이 올바르지 않습니다: ${value}`);
  }
  const [, year, month, day] = match;
  return new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
}

/** Date to `YYYY-MM-DD`, in UTC. */
export function formatDateOnly(date: Date): string {
  return date.toISOString().slice(0, 10);
}
