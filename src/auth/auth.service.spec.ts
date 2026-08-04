import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { UserRole } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../prisma/prisma.service';
import { AuthService } from './auth.service';

const PASSWORD = 'planforge';

async function buildService(user: Record<string, unknown> | null) {
  const prisma = {
    user: { findUnique: jest.fn().mockResolvedValue(user), update: jest.fn() },
  };
  const jwt = { signAsync: jest.fn().mockResolvedValue('signed.jwt.token') };
  const config = { get: jest.fn().mockReturnValue('8h') };

  const moduleRef = await Test.createTestingModule({
    providers: [
      AuthService,
      { provide: PrismaService, useValue: prisma },
      { provide: JwtService, useValue: jwt },
      { provide: ConfigService, useValue: config },
    ],
  }).compile();

  return { service: moduleRef.get(AuthService), prisma, jwt };
}

async function activeUser(overrides: Record<string, unknown> = {}) {
  return {
    id: 'user-1',
    email: 'frontdesk@planforge.local',
    passwordHash: await bcrypt.hash(PASSWORD, 4),
    name: '프론트데스크',
    role: UserRole.FRONT_DESK,
    propertyId: 'prop-1',
    active: true,
    ...overrides,
  };
}

describe('AuthService', () => {
  describe('login', () => {
    it('올바른 자격이면 토큰과 사용자 정보를 준다', async () => {
      const { service, jwt, prisma } = await buildService(await activeUser());

      const result = await service.login({
        email: 'frontdesk@planforge.local',
        password: PASSWORD,
      });

      expect(result.accessToken).toBe('signed.jwt.token');
      expect(result.user).toEqual({
        id: 'user-1',
        email: 'frontdesk@planforge.local',
        name: '프론트데스크',
        role: UserRole.FRONT_DESK,
        propertyId: 'prop-1',
      });
      // The hash never leaves.
      expect(JSON.stringify(result)).not.toContain('$2');
      expect(jwt.signAsync).toHaveBeenCalledWith(
        expect.objectContaining({ sub: 'user-1', role: UserRole.FRONT_DESK }),
      );
      expect(prisma.user.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'user-1' } }),
      );
    });

    it('이메일 대소문자와 공백을 흡수한다', async () => {
      const { service, prisma } = await buildService(await activeUser());

      await service.login({ email: '  FrontDesk@PlanForge.Local ', password: PASSWORD });

      expect(prisma.user.findUnique).toHaveBeenCalledWith({
        where: { email: 'frontdesk@planforge.local' },
      });
    });

    it('비밀번호가 틀리면 거절한다', async () => {
      const { service } = await buildService(await activeUser());
      await expect(
        service.login({ email: 'frontdesk@planforge.local', password: 'wrong-password' }),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('비활성 계정은 거절한다', async () => {
      const { service } = await buildService(await activeUser({ active: false }));
      await expect(
        service.login({ email: 'frontdesk@planforge.local', password: PASSWORD }),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('없는 계정과 틀린 비밀번호의 문구가 같아 계정 존재 여부가 새지 않는다', async () => {
      const missing = await buildService(null);
      const wrong = await buildService(await activeUser());

      const a = await missing.service
        .login({ email: 'nobody@planforge.local', password: PASSWORD })
        .catch((e: Error) => e.message);
      const b = await wrong.service
        .login({ email: 'frontdesk@planforge.local', password: 'wrong-password' })
        .catch((e: Error) => e.message);

      expect(a).toBe(b);
    });
  });

  describe('me', () => {
    it('활성 계정을 돌려준다', async () => {
      const { service } = await buildService(await activeUser());
      await expect(service.me('user-1')).resolves.toMatchObject({ id: 'user-1' });
    });

    it('토큰 발급 후 비활성화된 계정은 거절한다', async () => {
      const { service } = await buildService(await activeUser({ active: false }));
      await expect(service.me('user-1')).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('삭제된 계정은 거절한다', async () => {
      const { service } = await buildService(null);
      await expect(service.me('gone')).rejects.toBeInstanceOf(UnauthorizedException);
    });
  });
});
