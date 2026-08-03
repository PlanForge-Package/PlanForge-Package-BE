import { ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { UserRole } from '@prisma/client';
import { REQUIRED_ROLES } from './auth.constants';
import { RolesGuard } from './roles.guard';

function contextFor(role?: UserRole) {
  const request = role ? { user: { id: 'u1', role } } : {};
  return {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => () => undefined,
    getClass: () => class {},
  } as never;
}

function guardWith(required?: UserRole[]) {
  const reflector = new Reflector();
  jest
    .spyOn(reflector, 'getAllAndOverride')
    .mockImplementation((key) => (key === REQUIRED_ROLES ? required : undefined) as never);
  return new RolesGuard(reflector);
}

describe('RolesGuard', () => {
  it('@Roles 가 없으면 인증만으로 통과한다', () => {
    expect(guardWith(undefined).canActivate(contextFor(UserRole.HOUSEKEEPING))).toBe(true);
  });

  it('요구 역할과 일치하면 통과한다', () => {
    const guard = guardWith([UserRole.MANAGER, UserRole.FRONT_DESK]);
    expect(guard.canActivate(contextFor(UserRole.FRONT_DESK))).toBe(true);
  });

  it('ADMIN 은 목록에 없어도 항상 통과한다', () => {
    const guard = guardWith([UserRole.FRONT_DESK]);
    expect(guard.canActivate(contextFor(UserRole.ADMIN))).toBe(true);
  });

  it('권한이 없으면 403 을 낸다', () => {
    const guard = guardWith([UserRole.MANAGER, UserRole.FRONT_DESK]);
    expect(() => guard.canActivate(contextFor(UserRole.HOUSEKEEPING))).toThrow(ForbiddenException);
  });

  it('인증 주체가 없으면 통과시키지 않는다', () => {
    const guard = guardWith([UserRole.MANAGER]);
    expect(() => guard.canActivate(contextFor(undefined))).toThrow(ForbiddenException);
  });
});
