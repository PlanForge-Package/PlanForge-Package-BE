import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { MembershipTier, Prisma, UserRole } from '@prisma/client';
import type { AuthUser } from '../auth/auth.constants';
import { CoreClient } from '../core/core.client';
import { PrismaService } from '../prisma/prisma.service';
import { ProfilesService } from './profiles.service';

const HQ: AuthUser = {
  id: 'u1',
  sub: 'u1',
  email: 'a@b.c',
  name: '본사',
  role: UserRole.MANAGER,
  propertyId: null,
};

function profile(overrides: Record<string, unknown> = {}) {
  return {
    id: 'pf-1',
    operaProfileId: null,
    firstName: 'Gildong',
    lastName: 'Hong',
    companyName: null,
    email: 'gildong@example.com',
    phone: '01012345678',
    nationality: 'KR',
    vip: false,
    membershipNumber: null,
    membershipTier: MembershipTier.NONE,
    preferences: [] as string[],
    notes: null,
    mergedIntoId: null,
    ...overrides,
  };
}

function buildPrisma(overrides: Record<string, unknown> = {}) {
  const tx = {
    reservation: { updateMany: jest.fn().mockResolvedValue({ count: 2 }) },
    profile: { update: jest.fn().mockImplementation(({ data }) => ({ id: 'pf-2', ...data })) },
  };

  return {
    tx,
    profile: {
      findUnique: jest.fn().mockResolvedValue(profile()),
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      update: jest.fn().mockImplementation(({ data }) => ({ id: 'pf-1', ...data })),
      ...(overrides.profile ?? {}),
    },
    reservation: { findMany: jest.fn().mockResolvedValue([]) },
    syncLog: { create: jest.fn().mockResolvedValue({ id: 'log-1' }), update: jest.fn() },
    $transaction: jest.fn((fn: (t: typeof tx) => unknown) => fn(tx)),
  };
}

function buildCore() {
  return { mergeProfile: jest.fn().mockResolvedValue({ profileId: 'PRF-2' }) };
}

async function buildService(
  prisma: ReturnType<typeof buildPrisma>,
  core: ReturnType<typeof buildCore> = buildCore(),
) {
  const moduleRef = await Test.createTestingModule({
    providers: [
      ProfilesService,
      { provide: PrismaService, useValue: prisma },
      { provide: CoreClient, useValue: core },
    ],
  }).compile();
  return moduleRef.get(ProfilesService);
}

describe('ProfilesService — 목록', () => {
  // Merged profiles in the list make it unclear which one to write to.
  it('병합된 프로필은 기본으로 숨긴다', async () => {
    const prisma = buildPrisma();
    const service = await buildService(prisma);

    await service.list({});
    expect(prisma.profile.findMany.mock.calls[0][0].where).toEqual(
      expect.objectContaining({ mergedIntoId: null }),
    );
  });

  it('includeMerged 를 주면 조건을 빼고 조회한다', async () => {
    const prisma = buildPrisma();
    const service = await buildService(prisma);

    await service.list({ includeMerged: true });
    expect(prisma.profile.findMany.mock.calls[0][0].where.mergedIntoId).toBeUndefined();
  });

  // A number with hyphens and one without must not be different people.
  it('전화 검색은 숫자만 남겨 비교한다', async () => {
    const prisma = buildPrisma();
    const service = await buildService(prisma);

    await service.list({ q: '010-1234-5678' });
    const or = prisma.profile.findMany.mock.calls[0][0].where.OR;
    expect(or).toEqual(expect.arrayContaining([{ phone: { contains: '01012345678' } }]));
  });
});

describe('ProfilesService — 수정', () => {
  it('선호는 중복을 걷어낸다', async () => {
    const prisma = buildPrisma();
    const service = await buildService(prisma);

    await service.update('pf-1', { preferences: ['HIGH_FLOOR', 'HIGH_FLOOR', 'QUIET_ROOM'] });
    expect(prisma.profile.update.mock.calls[0][0].data.preferences).toEqual([
      'HIGH_FLOOR',
      'QUIET_ROOM',
    ]);
  });

  // Free text lets equivalent wordings pile up and become unfilterable at assignment.
  it('알 수 없는 선호 코드는 거절한다', async () => {
    const service = await buildService(buildPrisma());
    await expect(service.update('pf-1', { preferences: ['고층'] })).rejects.toMatchObject({
      response: { code: 'PROFILE_PREFERENCE_UNKNOWN' },
    });
  });

  it('이메일은 소문자로 맞춘다', async () => {
    const prisma = buildPrisma();
    const service = await buildService(prisma);

    await service.update('pf-1', { email: 'Gildong@Example.COM' });
    expect(prisma.profile.update.mock.calls[0][0].data.email).toBe('gildong@example.com');
  });

  it('병합된 프로필은 수정할 수 없다', async () => {
    const prisma = buildPrisma();
    prisma.profile.findUnique.mockResolvedValue(profile({ mergedIntoId: 'pf-2' }));
    const service = await buildService(prisma);

    await expect(service.update('pf-1', { vip: true })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('없는 프로필은 404 로 알린다', async () => {
    const prisma = buildPrisma();
    prisma.profile.findUnique.mockResolvedValue(null);
    const service = await buildService(prisma);

    await expect(service.update('nope', { vip: true })).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('ProfilesService — 중복 후보', () => {
  it('근거를 함께 돌려준다', async () => {
    const prisma = buildPrisma();
    prisma.profile.findMany.mockResolvedValue([
      profile({ id: 'pf-2', phone: '01012345678', firstName: 'Gildong', lastName: 'Hong' }),
    ]);
    const service = await buildService(prisma);

    const result = await service.duplicates('pf-1');
    expect(result.items[0]?.reasons).toEqual(
      expect.arrayContaining(['SAME_EMAIL', 'SAME_PHONE', 'SAME_NAME']),
    );
  });

  it('비교할 값이 없으면 조회하지 않는다', async () => {
    const prisma = buildPrisma();
    prisma.profile.findUnique.mockResolvedValue(
      profile({ email: null, phone: null, membershipNumber: null, firstName: null }),
    );
    const service = await buildService(prisma);

    const result = await service.duplicates('pf-1');
    expect(result.items).toEqual([]);
    expect(prisma.profile.findMany).not.toHaveBeenCalled();
  });
});

describe('ProfilesService — 병합', () => {
  function mergePrisma(source: object, target: object) {
    const prisma = buildPrisma();
    prisma.profile.findUnique.mockImplementation(({ where }: { where: { id: string } }) =>
      where.id === 'src' ? source : target,
    );
    return prisma;
  }

  it('예약을 정본으로 옮기고 원본에는 흔적을 남긴다', async () => {
    const prisma = mergePrisma(
      profile({ id: 'src', preferences: ['QUIET_ROOM'] }),
      profile({ id: 'dst', email: null, preferences: ['HIGH_FLOOR'] }),
    );
    const service = await buildService(prisma);

    await service.merge('src', 'dst');

    expect(prisma.tx.reservation.updateMany).toHaveBeenCalledWith({
      where: { profileId: 'src' },
      data: { profileId: 'dst' },
    });
    const [targetUpdate, sourceUpdate] = prisma.tx.profile.update.mock.calls;
    expect(targetUpdate[0].data.preferences.sort()).toEqual(['HIGH_FLOOR', 'QUIET_ROOM']);
    // Only the fields the canonical profile left empty are filled.
    expect(targetUpdate[0].data.email).toBe('gildong@example.com');
    expect(sourceUpdate[0].data.mergedIntoId).toBe('dst');
  });

  // Overwriting a value the canonical profile already has loses the chosen one.
  it('정본의 값을 덮어쓰지 않는다', async () => {
    const prisma = mergePrisma(
      profile({ id: 'src', firstName: 'WRONG' }),
      profile({ id: 'dst', firstName: 'RIGHT' }),
    );
    const service = await buildService(prisma);

    await service.merge('src', 'dst');
    expect(prisma.tx.profile.update.mock.calls[0][0].data.firstName).toBe('RIGHT');
  });

  // Downgrading drops the VIP service that goes with it.
  it('한쪽이라도 VIP 면 VIP 로 남긴다', async () => {
    const prisma = mergePrisma(
      profile({ id: 'src', vip: true }),
      profile({ id: 'dst', vip: false }),
    );
    const service = await buildService(prisma);

    await service.merge('src', 'dst');
    expect(prisma.tx.profile.update.mock.calls[0][0].data.vip).toBe(true);
  });

  // Merged locally only, OPERA still has two and the next sync revives the removed one.
  it('양쪽 모두 OPERA 프로필이면 OPERA 에 먼저 위임한다', async () => {
    const prisma = mergePrisma(
      profile({ id: 'src', operaProfileId: 'PRF-1' }),
      profile({ id: 'dst', operaProfileId: 'PRF-2' }),
    );
    const core = buildCore();
    const service = await buildService(prisma, core);

    await service.merge('src', 'dst');
    expect(core.mergeProfile).toHaveBeenCalledWith('PRF-1', 'PRF-2');
    expect(prisma.$transaction).toHaveBeenCalled();
  });

  // A half-merge is the worst state. If OPERA refuses, nothing local changes.
  it('OPERA 가 거절하면 로컬을 바꾸지 않는다', async () => {
    const prisma = mergePrisma(
      profile({ id: 'src', operaProfileId: 'PRF-1' }),
      profile({ id: 'dst', operaProfileId: 'PRF-2' }),
    );
    const core = buildCore();
    core.mergeProfile.mockRejectedValue(new Error('이미 병합된 프로필'));
    const service = await buildService(prisma, core);

    await expect(service.merge('src', 'dst')).rejects.toThrow(/이미 병합된 프로필/);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.syncLog.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'FAILED' }) }),
    );
  });

  // A local-only profile has nothing to merge in OPERA.
  it('원본이 OPERA 프로필이 아니면 위임하지 않는다', async () => {
    const prisma = mergePrisma(
      profile({ id: 'src', operaProfileId: null }),
      profile({ id: 'dst', operaProfileId: 'PRF-2' }),
    );
    const core = buildCore();
    const service = await buildService(prisma, core);

    await service.merge('src', 'dst');
    expect(core.mergeProfile).not.toHaveBeenCalled();
  });

  // operaProfileId is unique. Moved over but left on the source, the next save fails.
  it('OPERA ID 를 옮겼으면 원본에서 떼어 낸다', async () => {
    const prisma = mergePrisma(
      profile({ id: 'src', operaProfileId: 'PRF-1' }),
      profile({ id: 'dst', operaProfileId: null }),
    );
    const service = await buildService(prisma);

    await service.merge('src', 'dst');
    const [targetUpdate, sourceUpdate] = prisma.tx.profile.update.mock.calls;
    expect(targetUpdate[0].data.operaProfileId).toBe('PRF-1');
    expect(sourceUpdate[0].data.operaProfileId).toBeNull();
  });

  it('자기 자신과는 병합할 수 없다', async () => {
    const service = await buildService(buildPrisma());
    await expect(service.merge('pf-1', 'pf-1')).rejects.toMatchObject({
      response: { code: 'PROFILE_MERGE_SELF' },
    });
  });

  it('이미 병합된 프로필은 다시 병합할 수 없다', async () => {
    const prisma = mergePrisma(
      profile({ id: 'src', mergedIntoId: 'other' }),
      profile({ id: 'dst' }),
    );
    const service = await buildService(prisma);

    await expect(service.merge('src', 'dst')).rejects.toMatchObject({
      response: { code: 'PROFILE_ALREADY_MERGED' },
    });
  });

  it('대상이 병합된 프로필이면 거절한다', async () => {
    const prisma = mergePrisma(
      profile({ id: 'src' }),
      profile({ id: 'dst', mergedIntoId: 'other' }),
    );
    const service = await buildService(prisma);

    await expect(service.merge('src', 'dst')).rejects.toMatchObject({
      response: { code: 'PROFILE_TARGET_MERGED' },
    });
  });
});

describe('ProfilesService — 상세', () => {
  it('투숙 이력에서 누적 박수와 매출을 계산한다', async () => {
    const prisma = buildPrisma();
    prisma.reservation.findMany.mockResolvedValue([
      {
        arrivalDate: new Date(Date.UTC(2026, 7, 1)),
        departureDate: new Date(Date.UTC(2026, 7, 4)),
        totalAmount: new Prisma.Decimal(300000),
      },
      {
        arrivalDate: new Date(Date.UTC(2026, 6, 1)),
        departureDate: new Date(Date.UTC(2026, 6, 2)),
        totalAmount: new Prisma.Decimal(100000),
      },
    ]);
    const service = await buildService(prisma);

    const result = await service.findOne('pf-1', HQ);
    expect(result.summary.stayCount).toBe(2);
    expect(result.summary.nights).toBe(4);
    expect(result.summary.revenue).toBe('400000.00');
  });

  // Staff of one hotel reading another's stay records is a privacy exposure in itself.
  it('소속이 있는 계정은 자기 호텔 이력만 본다', async () => {
    const prisma = buildPrisma();
    const service = await buildService(prisma);
    const scoped: AuthUser = { ...HQ, propertyId: 'prop-1' };

    await service.findOne('pf-1', scoped);
    expect(prisma.reservation.findMany.mock.calls[0][0].where).toEqual(
      expect.objectContaining({ propertyId: 'prop-1' }),
    );
  });
});
