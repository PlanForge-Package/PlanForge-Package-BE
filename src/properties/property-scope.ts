import { ForbiddenException } from '@nestjs/common';
import type { AuthUser } from '../auth/auth.constants';

/**
 * 요청이 볼 수 있는 호텔 범위를 정한다.
 *
 * 다중 호텔에서는 이것이 가장 중요한 경계다. 소속이 지정된 직원이 쿼리스트링의
 * propertyId 만 바꿔 남의 호텔 예약과 게스트 정보를 열람할 수 있으면, 역할 검사를
 * 아무리 촘촘히 해도 소용이 없다.
 *
 * - 소속이 없는 계정(본사·ADMIN): 원하는 호텔을 지정할 수 있고, 생략하면 전체를 본다.
 * - 소속이 있는 계정: 자기 호텔로 고정된다. 다른 호텔을 지정하면 거절한다.
 *
 * @returns 조회에 쓸 propertyId. `undefined` 면 전 호텔이다.
 */
export function resolvePropertyScope(user: AuthUser, requested?: string): string | undefined {
  const assigned = user.propertyId;

  if (!assigned) {
    return requested || undefined;
  }

  if (requested && requested !== assigned) {
    throw new ForbiddenException('다른 호텔의 자료에는 접근할 수 없습니다.');
  }

  return assigned;
}

/**
 * 이미 조회한 자료가 요청자의 범위 안에 있는지 확인한다.
 *
 * 목록은 범위로 걸러지지만 단건 조회는 ID 만 알면 닿는다. 확인 번호나 URL 이
 * 새어 나가는 것만으로 남의 호텔 예약이 열리면 안 된다.
 */
export function assertWithinScope(user: AuthUser, propertyId: string): void {
  if (user.propertyId && user.propertyId !== propertyId) {
    throw new ForbiddenException('다른 호텔의 자료에는 접근할 수 없습니다.');
  }
}
