/**
 * 호텔 현지 시각을 UTC 로 바꾼다.
 *
 * 키 유효 기간은 반드시 현지 시각 기준이어야 한다. UTC 로 "출발일 12시" 를
 * 잡으면 서울에서는 밤 9시가 되어, 체크아웃한 손님의 카드가 반나절 더 살아
 * 있는다. 그 방에 다음 손님이 들어온 뒤까지 열린다.
 *
 * 라이브러리를 들이지 않고 `Intl` 로 처리한다 — 같은 순간을 대상 타임존과 UTC
 * 로 각각 읽어 그 차이만큼 밀어 준다. 서머타임 전환 시각 한두 시간의 오차는
 * 남지만, 한국·일본처럼 서머타임이 없는 지역에서는 정확하다.
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

/** 그 순간 해당 타임존이 UTC 보다 얼마나 앞서는지(밀리초). */
function zoneOffsetMs(instant: Date, timeZone: string): number {
  try {
    const asZone = new Date(instant.toLocaleString('en-US', { timeZone }));
    const asUtc = new Date(instant.toLocaleString('en-US', { timeZone: 'UTC' }));
    return asZone.getTime() - asUtc.getTime();
  } catch {
    // 알 수 없는 타임존이면 UTC 로 둔다. 키를 아예 못 만드는 것보다 낫고,
    // 호텔 설정이 잘못됐다는 사실은 유효 기간 표시에서 드러난다.
    return 0;
  }
}
