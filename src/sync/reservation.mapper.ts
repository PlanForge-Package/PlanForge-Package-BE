import { ReservationStatus } from '@prisma/client';
import type { CoreReservationStatus } from '../core/core.types';

/** Core(OPERA 표기) → PlanForge 예약 상태. */
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

/** PlanForge → Core(OPERA 표기). 역방향 조회 필터에 쓴다. */
export function toCoreStatus(status: ReservationStatus): CoreReservationStatus | undefined {
  const entry = Object.entries(STATUS_MAP).find(([, value]) => value === status);
  return entry?.[0] as CoreReservationStatus | undefined;
}

/**
 * `YYYY-MM-DD` 를 Date 로 바꾼다.
 *
 * Prisma `@db.Date` 컬럼은 UTC 자정으로 저장되므로, 로컬 타임존이 UTC 뒤쪽일 때
 * 하루 밀리는 것을 막기 위해 반드시 UTC 로 파싱한다.
 */
export function parseDateOnly(value: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!match) {
    throw new Error(`날짜 형식이 올바르지 않습니다: ${value}`);
  }
  const [, year, month, day] = match;
  return new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
}

/** Date → `YYYY-MM-DD` (UTC 기준). */
export function formatDateOnly(date: Date): string {
  return date.toISOString().slice(0, 10);
}
