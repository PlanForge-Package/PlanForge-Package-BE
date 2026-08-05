/**
 * Calendar dates, as `YYYY-MM-DD` strings.
 *
 * `@db.Date` columns are stored at UTC midnight, so a date built from local time lands
 * a day early in any zone behind UTC. Every date here goes through `toISOString` for
 * that reason, and the services no longer each keep their own copy of the rule.
 */

/** The day part of a Date, in UTC. */
export function toDateString(value: Date): string {
  return value.toISOString().slice(0, 10);
}

/** Today in UTC. */
export function todayString(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * `YYYY-MM-DD` as a UTC-midnight Date.
 *
 * `new Date('2026-08-05')` already parses as UTC, but only for that exact shape —
 * going through Date.UTC keeps it true whatever the input.
 */
export function toUtcDate(value: string): Date {
  const [year, month, day] = value.split('-').map(Number);
  return new Date(Date.UTC(year, (month ?? 1) - 1, day ?? 1));
}
