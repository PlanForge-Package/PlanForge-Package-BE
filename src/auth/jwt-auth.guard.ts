import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';
import { IS_PUBLIC, type AuthUser, type JwtPayload } from './auth.constants';

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
      throw new UnauthorizedException('인증 토큰이 필요합니다.');
    }

    let payload: JwtPayload;
    try {
      payload = await this.jwt.verifyAsync<JwtPayload>(token);
    } catch (error) {
      // Expiry and forgery are reported apart — the client can prompt for re-login differently.
      const expired = error instanceof Error && error.name === 'TokenExpiredError';
      throw new UnauthorizedException(
        expired ? '세션이 만료되었습니다. 다시 로그인해 주세요.' : '유효하지 않은 토큰입니다.',
      );
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
