import { ForbiddenException } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import type { AuthUser } from '../auth/auth.constants';
import { assertWithinScope, resolvePropertyScope } from './property-scope';

function userWith(propertyId: string | null, role: UserRole = UserRole.FRONT_DESK): AuthUser {
  return {
    id: 'u1',
    sub: 'u1',
    email: 'a@b.c',
    name: '홍',
    role,
    propertyId,
  };
}

describe('resolvePropertyScope', () => {
  describe('소속이 없는 계정 (본사·관리자)', () => {
    it('요청한 호텔을 그대로 쓴다', () => {
      expect(resolvePropertyScope(userWith(null), 'prop-2')).toBe('prop-2');
    });

    it('지정하지 않으면 전 호텔을 본다', () => {
      expect(resolvePropertyScope(userWith(null), undefined)).toBeUndefined();
    });

    it('빈 문자열도 전 호텔로 읽는다', () => {
      expect(resolvePropertyScope(userWith(null), '')).toBeUndefined();
    });
  });

  describe('소속이 있는 계정', () => {
    it('지정하지 않으면 자기 호텔로 고정된다', () => {
      expect(resolvePropertyScope(userWith('prop-1'), undefined)).toBe('prop-1');
    });

    it('자기 호텔을 지정하면 통과한다', () => {
      expect(resolvePropertyScope(userWith('prop-1'), 'prop-1')).toBe('prop-1');
    });

    it('다른 호텔을 지정하면 거절한다', () => {
      expect(() => resolvePropertyScope(userWith('prop-1'), 'prop-2')).toThrow(ForbiddenException);
    });

    // With a property it is fixed regardless of role. Even a manager cannot see another hotel.
    it('MANAGER 여도 다른 호텔은 거절한다', () => {
      expect(() => resolvePropertyScope(userWith('prop-1', UserRole.MANAGER), 'prop-2')).toThrow(
        ForbiddenException,
      );
    });

    it('ADMIN 이어도 소속이 있으면 고정된다', () => {
      expect(() => resolvePropertyScope(userWith('prop-1', UserRole.ADMIN), 'prop-2')).toThrow(
        ForbiddenException,
      );
    });
  });
});

describe('assertWithinScope', () => {
  it('소속이 없으면 어떤 호텔이든 통과한다', () => {
    expect(() => assertWithinScope(userWith(null), 'prop-9')).not.toThrow();
  });

  it('자기 호텔이면 통과한다', () => {
    expect(() => assertWithinScope(userWith('prop-1'), 'prop-1')).not.toThrow();
  });

  it('다른 호텔이면 거절한다', () => {
    expect(() => assertWithinScope(userWith('prop-1'), 'prop-2')).toThrow(ForbiddenException);
  });
});
