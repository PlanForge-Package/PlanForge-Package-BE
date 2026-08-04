import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { UserRole } from '@prisma/client';
import type { Request } from 'express';
import { REQUIRED_ROLES, type AuthUser } from './auth.constants';

/**
 * Role check. Routes without `@Roles()` need only authentication.
 *
 * ADMIN always passes — it stops us locking ourselves out by forgetting ADMIN in
 * the list every time a permission is added.
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

    // The auth guard runs first, so a missing user here means the wiring is wrong.
    if (!user) {
      throw new ForbiddenException('권한을 확인할 수 없습니다.');
    }

    if (user.role === UserRole.ADMIN || required.includes(user.role)) return true;

    throw new ForbiddenException('이 작업을 수행할 권한이 없습니다.');
  }
}
