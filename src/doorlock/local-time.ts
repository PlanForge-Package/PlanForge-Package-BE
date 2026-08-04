/**
 * Converts the hotel's local time to UTC.
 *
 * Key validity has to be based on local time. Setting "noon on the departure day"
 * in UTC makes it 9pm in Seoul, so a departed guest's card lives half a day longer
 * — past the point the next guest moves into that room.
 *
 * Handled with `Intl` rather than pulling in a library — the same instant is read in
 * the target zone and in UTC and shifted by the difference. An hour or two of error
 * remains across a DST transition, but zones without DST like Korea and Japan are exact.
 */
export function zonedHourToUtc(dateOnly: string, hour: number, timeZone: string): Date {
  const iso = `${dateOnly}T${String(hour).padStart(2, '0')}:00:00Z`;
  const guess = new Date(iso);
  if (Number.isNaN(guess.getTime())) {
    throw new Error(`날짜 형식이 올바르지 않습니다: ${dateOnly}`);
  }

  const offsetMs = zoneOffsetMs(guess, timeZone);
  return new Date(guess.getTime() - offsetMs);
}

/** How far ahead of UTC that zone is at that instant, in milliseconds. */
function zoneOffsetMs(instant: Date, timeZone: string): number {
  try {
    const asZone = new Date(instant.toLocaleString('en-US', { timeZone }));
    const asUtc = new Date(instant.toLocaleString('en-US', { timeZone: 'UTC' }));
    return asZone.getTime() - asUtc.getTime();
  } catch {
    // An unknown zone falls back to UTC. Better than failing to make a key at all,
    // and a wrong hotel setting shows up in the displayed validity.
    return 0;
  }
}
