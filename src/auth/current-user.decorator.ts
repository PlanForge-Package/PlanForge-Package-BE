import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import type { AuthUser } from './auth.constants';

/** Pulls the principal the guard set out as a handler argument. */
export const CurrentUser = createParamDecorator((_data: unknown, ctx: ExecutionContext) => {
  const request = ctx.switchToHttp().getRequest<Request & { user?: AuthUser }>();
  return request.user;
});
