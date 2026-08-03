import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Prisma, UserRole } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../prisma/prisma.service';
import { UsersService } from './users.service';

function buildPrisma(overrides: Record<string, unknown> = {}) {
  return {
    user: {
      findUnique: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      create: jest.fn(),
      update: jest.fn().mockResolvedValue({ id: 'u1' }),
    },
    property: { findUnique: jest.fn().mockResolvedValue({ id: 'prop-1' }) },
    ...overrides,
  };
}

async function buildService(prisma: ReturnType<typeof buildPrisma>) {
  const moduleRef = await Test.createTestingModule({
    providers: [UsersService, { provide: PrismaService, useValue: prisma }],
  }).compile();
  return moduleRef.get(UsersService);
}

const ADMIN = { id: 'admin-1', role: UserRole.ADMIN, active: true };
const STAFF = { id: 'staff-1', role: UserRole.FRONT_DESK, active: true };

describe('UsersService', () => {
  describe('create', () => {
    it('비밀번호를 해시로 저장하고 해시는 반환하지 않는다', async () => {
      const prisma = buildPrisma();
      prisma.user.create.mockResolvedValue({ id: 'u1', email: 'a@b.c' });

      const service = await buildService(prisma);
      await service.create({
        email: 'a@b.c',
        name: '홍길동',
        password: 'planforge',
        role: UserRole.FRONT_DESK,
      });

      const data = prisma.user.create.mock.calls[0][0].data;
      expect(data.passwordHash).not.toBe('planforge');
      expect(await bcrypt.compare('planforge', data.passwordHash)).toBe(true);
      // select 에 passwordHash 가 없어야 응답으로 새지 않는다.
      expect(prisma.user.create.mock.calls[0][0].select.passwordHash).toBeUndefined();
    });

    // meta.target 은 Prisma 버전·드라이버에 따라 형태가 다르고, 아예 비는 경우도 있다.
    // 실제로 6.19 는 "(not available)" 을 주어 필드명 매칭만으로는 놓쳤다.
    it.each([
      ['필드 배열', { target: ['email'] }],
      ['인덱스 이름', { target: 'users_email_key' }],
      ['인덱스 이름 배열', { target: ['users_email_key'] }],
      ['target 없음', {}],
      ['meta 없음', undefined],
    ])('이메일 중복이면 409 로 알린다 (%s)', async (_label, meta) => {
      const prisma = buildPrisma();
      prisma.user.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('dup', {
          code: 'P2002',
          clientVersion: '6',
          ...(meta ? { meta } : {}),
        }),
      );

      const service = await buildService(prisma);
      await expect(
        service.create({
          email: 'a@b.c',
          name: '홍',
          password: 'planforge',
          role: UserRole.FRONT_DESK,
        }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('고유 제약 위반이 아닌 오류는 그대로 올린다', async () => {
      const prisma = buildPrisma();
      prisma.user.create.mockRejectedValue(new Error('연결 끊김'));

      const service = await buildService(prisma);
      await expect(
        service.create({
          email: 'a@b.c',
          name: '홍',
          password: 'planforge',
          role: UserRole.FRONT_DESK,
        }),
      ).rejects.toThrow(/연결 끊김/);
    });

    it('없는 호텔을 지정하면 거절한다', async () => {
      const prisma = buildPrisma();
      prisma.property.findUnique.mockResolvedValue(null);

      const service = await buildService(prisma);
      await expect(
        service.create({
          email: 'a@b.c',
          name: '홍',
          password: 'planforge',
          role: UserRole.FRONT_DESK,
          propertyId: 'nope',
        }),
      ).rejects.toThrow(/호텔을 찾을 수 없습니다/);
    });
  });

  describe('update — 자기 잠김 방지', () => {
    it('자기 계정은 비활성화할 수 없다', async () => {
      const prisma = buildPrisma();
      prisma.user.findUnique.mockResolvedValue(ADMIN);

      const service = await buildService(prisma);
      await expect(service.update('admin-1', { active: false }, 'admin-1')).rejects.toThrow(
        /자기 계정은 비활성화할 수 없습니다/,
      );
    });

    it('자기 역할은 변경할 수 없다', async () => {
      const prisma = buildPrisma();
      prisma.user.findUnique.mockResolvedValue(ADMIN);

      const service = await buildService(prisma);
      await expect(
        service.update('admin-1', { role: UserRole.FRONT_DESK }, 'admin-1'),
      ).rejects.toThrow(/자기 역할은 변경할 수 없습니다/);
    });

    it('자기 이름 변경은 허용한다', async () => {
      const prisma = buildPrisma();
      prisma.user.findUnique.mockResolvedValue(ADMIN);

      const service = await buildService(prisma);
      await expect(
        service.update('admin-1', { name: '새 이름' }, 'admin-1'),
      ).resolves.toBeDefined();
    });

    it('같은 역할을 다시 지정하는 것은 변경이 아니므로 통과한다', async () => {
      const prisma = buildPrisma();
      prisma.user.findUnique.mockResolvedValue(ADMIN);

      const service = await buildService(prisma);
      await expect(
        service.update('admin-1', { role: UserRole.ADMIN }, 'admin-1'),
      ).resolves.toBeDefined();
    });
  });

  describe('update — 마지막 관리자 보호', () => {
    it('마지막 관리자의 역할을 내릴 수 없다', async () => {
      const prisma = buildPrisma();
      prisma.user.findUnique.mockResolvedValue({ ...ADMIN, id: 'admin-2' });
      prisma.user.count.mockResolvedValue(1);

      const service = await buildService(prisma);
      await expect(
        service.update('admin-2', { role: UserRole.MANAGER }, 'admin-1'),
      ).rejects.toThrow(/마지막 관리자/);
    });

    it('마지막 관리자를 비활성화할 수 없다', async () => {
      const prisma = buildPrisma();
      prisma.user.findUnique.mockResolvedValue({ ...ADMIN, id: 'admin-2' });
      prisma.user.count.mockResolvedValue(1);

      const service = await buildService(prisma);
      await expect(service.update('admin-2', { active: false }, 'admin-1')).rejects.toThrow(
        /마지막 관리자/,
      );
    });

    it('관리자가 둘 이상이면 강등할 수 있다', async () => {
      const prisma = buildPrisma();
      prisma.user.findUnique.mockResolvedValue({ ...ADMIN, id: 'admin-2' });
      prisma.user.count.mockResolvedValue(2);

      const service = await buildService(prisma);
      await expect(
        service.update('admin-2', { role: UserRole.MANAGER }, 'admin-1'),
      ).resolves.toBeDefined();
    });

    it('관리자가 아닌 계정 비활성화는 관리자 수를 세지 않는다', async () => {
      const prisma = buildPrisma();
      prisma.user.findUnique.mockResolvedValue(STAFF);

      const service = await buildService(prisma);
      await expect(service.update('staff-1', { active: false }, 'admin-1')).resolves.toBeDefined();
      expect(prisma.user.count).not.toHaveBeenCalled();
    });
  });

  describe('update — 소속 호텔', () => {
    it('빈 문자열은 소속 없음(본사)으로 저장한다', async () => {
      const prisma = buildPrisma();
      prisma.user.findUnique.mockResolvedValue(STAFF);

      const service = await buildService(prisma);
      await service.update('staff-1', { propertyId: '' }, 'admin-1');

      expect(prisma.user.update.mock.calls[0][0].data.propertyId).toBeNull();
    });
  });

  describe('changeOwnPassword', () => {
    async function userWith(password: string) {
      return { id: 'u1', passwordHash: await bcrypt.hash(password, 4) };
    }

    it('현재 비밀번호가 맞으면 바꾼다', async () => {
      const prisma = buildPrisma();
      prisma.user.findUnique.mockResolvedValue(await userWith('planforge'));

      const service = await buildService(prisma);
      await expect(service.changeOwnPassword('u1', 'planforge', 'new-password-1')).resolves.toEqual(
        { ok: true },
      );

      const data = prisma.user.update.mock.calls[0][0].data;
      expect(await bcrypt.compare('new-password-1', data.passwordHash)).toBe(true);
    });

    it('현재 비밀번호가 틀리면 거절한다', async () => {
      const prisma = buildPrisma();
      prisma.user.findUnique.mockResolvedValue(await userWith('planforge'));

      const service = await buildService(prisma);
      await expect(service.changeOwnPassword('u1', 'wrong', 'new-password-1')).rejects.toThrow(
        /현재 비밀번호가 올바르지 않습니다/,
      );
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('같은 비밀번호로 바꾸는 것은 거절한다', async () => {
      const prisma = buildPrisma();
      prisma.user.findUnique.mockResolvedValue(await userWith('planforge'));

      const service = await buildService(prisma);
      await expect(
        service.changeOwnPassword('u1', 'planforge', 'planforge'),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('없는 계정이면 404 를 낸다', async () => {
      const prisma = buildPrisma();
      prisma.user.findUnique.mockResolvedValue(null);

      const service = await buildService(prisma);
      await expect(service.changeOwnPassword('gone', 'a', 'b')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('list', () => {
    it('기본은 활성 계정만 본다', async () => {
      const prisma = buildPrisma();
      const service = await buildService(prisma);
      await service.list({});

      expect(prisma.user.findMany.mock.calls[0][0].where.active).toBe(true);
    });

    it('includeInactive 면 활성 조건을 걸지 않는다', async () => {
      const prisma = buildPrisma();
      const service = await buildService(prisma);
      await service.list({ includeInactive: true });

      expect(prisma.user.findMany.mock.calls[0][0].where.active).toBeUndefined();
    });
  });
});
