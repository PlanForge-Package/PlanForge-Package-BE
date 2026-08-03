import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { UserRole } from '@prisma/client';
import type { Request } from 'express';
import { REQUIRED_ROLES, type AuthUser } from './auth.constants';

/**
 * 역할 검사. `@Roles()` 가 없는 라우트는 인증만 통과하면 된다.
 *
 * ADMIN 은 항상 통과한다 — 권한을 늘릴 때마다 ADMIN 을 목록에 빠뜨려 스스로
 * 잠기는 일을 막기 위해서다.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<UserRole[]>(REQUIRED_ROLES, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required || required.length === 0) return true;

    const request = context.switchToHttp().getRequest<Request & { user?: AuthUser }>();
    const user = request.user;

    // 인증 가드가 먼저 돌므로 여기서 user 가 없다면 배선이 잘못된 것이다.
    if (!user) {
      throw new ForbiddenException('권한을 확인할 수 없습니다.');
    }

    if (user.role === UserRole.ADMIN || required.includes(user.role)) return true;

    throw new ForbiddenException('이 작업을 수행할 권한이 없습니다.');
  }
}
