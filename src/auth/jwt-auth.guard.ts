import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';
import { IS_PUBLIC, type AuthUser, type JwtPayload } from './auth.constants';

/**
 * 전역 가드. `@Public()` 이 붙지 않은 모든 라우트에 유효한 Bearer 토큰을 요구한다.
 *
 * 화이트리스트가 아니라 블랙리스트로 갔다면 새 컨트롤러를 추가할 때마다 보호를
 * 잊을 수 있다. 기본을 "보호됨" 으로 두고 예외를 명시하는 편이 안전하다.
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
      // 만료와 위조를 구분해 알린다 — 클라이언트가 재로그인 안내를 다르게 줄 수 있다.
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
