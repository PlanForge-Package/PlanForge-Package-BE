import { UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { UserRole } from '@prisma/client';
import { IS_PUBLIC } from './auth.constants';
import { JwtAuthGuard } from './jwt-auth.guard';

interface Req {
  headers: { authorization?: string };
  user?: unknown;
}

function contextFor(request: Req) {
  return {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => () => undefined,
    getClass: () => class {},
  } as never;
}

function buildGuard(opts: { isPublic?: boolean; verify?: jest.Mock }) {
  const reflector = new Reflector();
  jest
    .spyOn(reflector, 'getAllAndOverride')
    .mockImplementation((key) => (key === IS_PUBLIC ? opts.isPublic : undefined) as never);

  const jwt = { verifyAsync: opts.verify ?? jest.fn() } as unknown as JwtService;
  return new JwtAuthGuard(jwt, reflector);
}

const PAYLOAD = {
  sub: 'u1',
  email: 'a@b.c',
  name: '홍',
  role: UserRole.FRONT_DESK,
  propertyId: null,
};

describe('JwtAuthGuard', () => {
  it('@Public 라우트는 토큰 없이 통과한다', async () => {
    const guard = buildGuard({ isPublic: true });
    await expect(guard.canActivate(contextFor({ headers: {} }))).resolves.toBe(true);
  });

  it('토큰이 없으면 401 을 낸다', async () => {
    const guard = buildGuard({});
    await expect(guard.canActivate(contextFor({ headers: {} }))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('Bearer 가 아닌 스킴은 거절한다', async () => {
    const guard = buildGuard({});
    await expect(
      guard.canActivate(contextFor({ headers: { authorization: 'Basic abc' } })),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('유효한 토큰이면 request.user 를 심는다', async () => {
    const guard = buildGuard({ verify: jest.fn().mockResolvedValue(PAYLOAD) });
    const request: Req = { headers: { authorization: 'Bearer good.token' } };

    await expect(guard.canActivate(contextFor(request))).resolves.toBe(true);
    expect(request.user).toEqual({ ...PAYLOAD, id: 'u1' });
  });

  it('스킴 대소문자를 가리지 않는다', async () => {
    const guard = buildGuard({ verify: jest.fn().mockResolvedValue(PAYLOAD) });
    const request: Req = { headers: { authorization: 'bearer good.token' } };
    await expect(guard.canActivate(contextFor(request))).resolves.toBe(true);
  });

  it('만료된 토큰은 재로그인 안내로 알린다', async () => {
    const expired = Object.assign(new Error('jwt expired'), { name: 'TokenExpiredError' });
    const guard = buildGuard({ verify: jest.fn().mockRejectedValue(expired) });

    await expect(
      guard.canActivate(contextFor({ headers: { authorization: 'Bearer old.token' } })),
    ).rejects.toMatchObject({ response: { code: 'SESSION_EXPIRED' } });
  });

  it('위조된 토큰은 다른 문구로 거절한다', async () => {
    const guard = buildGuard({
      verify: jest.fn().mockRejectedValue(new Error('invalid signature')),
    });

    await expect(
      guard.canActivate(contextFor({ headers: { authorization: 'Bearer forged' } })),
    ).rejects.toMatchObject({ response: { code: 'TOKEN_INVALID' } });
  });
});
