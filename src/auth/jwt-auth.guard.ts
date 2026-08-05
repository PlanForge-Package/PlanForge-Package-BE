import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';
import { IS_PUBLIC, type AuthUser, type JwtPayload } from './auth.constants';
import { unauthorized } from '../common/errors';

/**
 * Global guard. Every route without `@Public()` requires a valid Bearer token.
 *
 * A blacklist instead of a whitelist would mean forgetting protection on each new
 * controller. Defaulting to protected and naming the exceptions is safer.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<Request & { user?: AuthUser }>();
    const token = extractBearer(request.headers.authorization);
    if (!token) {
      throw unauthorized('TOKEN_REQUIRED');
    }

    let payload: JwtPayload;
    try {
      payload = await this.jwt.verifyAsync<JwtPayload>(token);
    } catch (error) {
      // Expiry and forgery are reported apart — the client can prompt for re-login differently.
      const expired = error instanceof Error && error.name === 'TokenExpiredError';
      throw unauthorized(expired ? 'SESSION_EXPIRED' : 'TOKEN_INVALID');
    }

    request.user = { ...payload, id: payload.sub };
    return true;
  }
}

function extractBearer(header: string | undefined): string | null {
  if (!header) return null;
  const [scheme, value] = header.split(' ');
  return scheme?.toLowerCase() === 'bearer' && value ? value : null;
}
