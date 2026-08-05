import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { UserRole } from '@prisma/client';
import { CoreClient } from '../core/core.client';
import { PrismaService } from '../prisma/prisma.service';
import { RatesService } from './rates.service';

const ACTOR = {
  id: 'user-1',
  sub: 'user-1',
  email: 'manager@planforge.local',
  name: '지배인',
  role: UserRole.MANAGER,
  propertyId: 'prop-1',
} as const;

const PLAN = {
  ratePlanCode: 'BAR',
  hotelId: 'SAND01',
  name: '기준 요금',
  currency: 'KRW',
  marketCode: 'TRANSIENT',
  sellStartDate: '2026-01-01',
  sellEndDate: '2026-12-31',
  baseAmounts: { STDT: 190000 },
  seasons: [],
  packageCodes: [],
  status: 'Active',
};

function buildPrisma(overrides: Record<string, unknown> = {}) {
  return {
    property: {
      findUnique: jest.fn().mockResolvedValue({
        id: 'prop-1',
        operaHotelId: 'SAND01',
        currency: 'KRW',
      }),
      ...((overrides.property as object) ?? {}),
    },
    roomType: {
      findMany: jest.fn().mockResolvedValue([{ code: 'STDT' }, { code: 'DLXK' }, { code: 'SUIT' }]),
      ...((overrides.roomType as object) ?? {}),
    },
    syncLog: {
      create: jest.fn().mockResolvedValue({ id: 'log-1' }),
      update: jest.fn(),
    },
  };
}

function buildCore(overrides: Record<string, unknown> = {}) {
  return {
    getRates: jest.fn().mockResolvedValue({
      hotelId: 'SAND01',
      arrivalDate: '2026-08-10',
      departureDate: '2026-08-12',
      nights: 2,
      offers: [],
    }),
    listRatePlans: jest.fn().mockResolvedValue({ hotelId: 'SAND01', items: [PLAN] }),
    getRatePlan: jest.fn().mockResolvedValue(PLAN),
    createRatePlan: jest.fn().mockResolvedValue(PLAN),
    updateRatePlan: jest.fn().mockResolvedValue(PLAN),
    addRateSeason: jest.fn().mockResolvedValue(PLAN),
    removeRateSeason: jest.fn().mockResolvedValue(PLAN),
    listPackages: jest.fn().mockResolvedValue({ hotelId: 'SAND01', items: [] }),
    createPackage: jest.fn().mockResolvedValue({ packageCode: 'BFAST' }),
    updatePackage: jest.fn().mockResolvedValue({ packageCode: 'BFAST' }),
    ...overrides,
  };
}

async function buildService(
  prisma: ReturnType<typeof buildPrisma>,
  core: ReturnType<typeof buildCore> = buildCore(),
) {
  const moduleRef = await Test.createTestingModule({
    providers: [
      RatesService,
      { provide: PrismaService, useValue: prisma },
      { provide: CoreClient, useValue: core },
    ],
  }).compile();
  return moduleRef.get(RatesService);
}

const NEW_PLAN = {
  ratePlanCode: 'promo',
  name: ' 여름 프로모션 ',
  sellStartDate: '2026-06-01',
  sellEndDate: '2026-08-31',
  baseAmounts: { STDT: 150000 },
};

describe('RatesService — 조회', () => {
  it('호텔의 OPERA 코드로 묻는다', async () => {
    const prisma = buildPrisma();
    const core = buildCore();
    const service = await buildService(prisma, core);

    await service.listPlans({}, ACTOR);

    expect(core.listRatePlans).toHaveBeenCalledWith('SAND01', undefined);
  });

  it('호텔을 고르지 않으면 거절한다', async () => {
    const prisma = buildPrisma();
    const service = await buildService(prisma);
    const hq = { ...ACTOR, propertyId: null };

    await expect(service.listPlans({}, hq)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('없는 호텔은 404 를 낸다', async () => {
    const prisma = buildPrisma({ property: { findUnique: jest.fn().mockResolvedValue(null) } });
    const service = await buildService(prisma);

    await expect(service.listPlans({}, ACTOR)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('출발일이 도착일보다 앞서면 요금을 묻지 않는다', async () => {
    const prisma = buildPrisma();
    const core = buildCore();
    const service = await buildService(prisma, core);

    await expect(
      service.quote({ arrivalDate: '2026-08-12', departureDate: '2026-08-10' }, ACTOR),
    ).rejects.toMatchObject({ response: { code: 'DEPARTURE_BEFORE_ARRIVAL' } });
    expect(core.getRates).not.toHaveBeenCalled();
  });

  // Some packages are per person, so the total changes with the guest count.
  it('인원을 그대로 넘긴다', async () => {
    const prisma = buildPrisma();
    const core = buildCore();
    const service = await buildService(prisma, core);

    await service.quote(
      { arrivalDate: '2026-08-10', departureDate: '2026-08-12', adults: 3 },
      ACTOR,
    );

    expect(core.getRates).toHaveBeenCalledWith(expect.objectContaining({ adults: 3 }));
  });
});

describe('RatesService — 요금 코드', () => {
  it('코드를 대문자로, 이름을 다듬어 보낸다', async () => {
    const prisma = buildPrisma();
    const core = buildCore();
    const service = await buildService(prisma, core);

    await service.createPlan({ ...NEW_PLAN }, ACTOR);

    expect(core.createRatePlan).toHaveBeenCalledWith(
      expect.objectContaining({
        ratePlanCode: 'PROMO',
        name: '여름 프로모션',
        hotelId: 'SAND01',
        currency: 'KRW',
      }),
    );
  });

  // OPERA rejects it too, but naming the valid codes makes it easier to fix on screen.
  it('모르는 객실 타입은 보내기 전에 거절한다', async () => {
    const prisma = buildPrisma();
    const core = buildCore();
    const service = await buildService(prisma, core);

    await expect(
      service.createPlan({ ...NEW_PLAN, baseAmounts: { NOPE: 100000 } }, ACTOR),
    ).rejects.toMatchObject({ response: { code: 'RATE_ROOM_TYPE_UNKNOWN' } });
    expect(core.createRatePlan).not.toHaveBeenCalled();
  });

  it('가능한 객실 타입을 메시지에 담는다', async () => {
    const prisma = buildPrisma();
    const service = await buildService(prisma);

    await expect(
      service.createPlan({ ...NEW_PLAN, baseAmounts: { NOPE: 1 } }, ACTOR),
    ).rejects.toThrow(/DLXK, STDT, SUIT/);
  });

  it('금액이 비어 있으면 거절한다', async () => {
    const prisma = buildPrisma();
    const service = await buildService(prisma);

    await expect(service.createPlan({ ...NEW_PLAN, baseAmounts: {} }, ACTOR)).rejects.toMatchObject(
      { response: { code: 'RATE_AMOUNTS_EMPTY' } },
    );
  });

  it('음수 금액은 거절한다', async () => {
    const prisma = buildPrisma();
    const service = await buildService(prisma);

    await expect(
      service.createPlan({ ...NEW_PLAN, baseAmounts: { STDT: -1 } }, ACTOR),
    ).rejects.toMatchObject({ response: { code: 'RATE_AMOUNT_INVALID' } });
  });

  it('소수점 금액은 거절한다', async () => {
    const prisma = buildPrisma();
    const service = await buildService(prisma);

    await expect(
      service.createPlan({ ...NEW_PLAN, baseAmounts: { STDT: 1000.5 } }, ACTOR),
    ).rejects.toMatchObject({ response: { code: 'RATE_AMOUNT_INVALID' } });
  });

  it('판매 종료일이 시작일보다 앞서면 거절한다', async () => {
    const prisma = buildPrisma();
    const core = buildCore();
    const service = await buildService(prisma, core);

    await expect(
      service.createPlan(
        { ...NEW_PLAN, sellStartDate: '2026-08-31', sellEndDate: '2026-06-01' },
        ACTOR,
      ),
    ).rejects.toMatchObject({ response: { code: 'RATE_SELL_END_BEFORE_START' } });
    expect(core.createRatePlan).not.toHaveBeenCalled();
  });

  it('수정에서도 객실 타입을 검사한다', async () => {
    const prisma = buildPrisma();
    const core = buildCore();
    const service = await buildService(prisma, core);

    await expect(
      service.updatePlan('BAR', { baseAmounts: { NOPE: 1000 } }, ACTOR),
    ).rejects.toMatchObject({ response: { code: 'RATE_ROOM_TYPE_UNKNOWN' } });
    expect(core.updateRatePlan).not.toHaveBeenCalled();
  });

  it('금액을 건드리지 않는 수정은 금액을 보내지 않는다', async () => {
    const prisma = buildPrisma();
    const core = buildCore();
    const service = await buildService(prisma, core);

    await service.updatePlan('BAR', { status: 'Inactive' }, ACTOR);

    const sent = core.updateRatePlan.mock.calls[0][1];
    expect(sent).not.toHaveProperty('baseAmounts');
    expect(sent.status).toBe('Inactive');
  });
});

describe('RatesService — 시즌', () => {
  const SEASON = {
    name: '성수기',
    startDate: '2026-07-15',
    endDate: '2026-08-20',
    amounts: { DLXK: 320000 },
  };

  it('시즌을 그대로 넘긴다', async () => {
    const prisma = buildPrisma();
    const core = buildCore();
    const service = await buildService(prisma, core);

    await service.addSeason('BAR', { ...SEASON, daysOfWeek: [5, 6] }, ACTOR);

    expect(core.addRateSeason).toHaveBeenCalledWith(
      'BAR',
      expect.objectContaining({ daysOfWeek: [5, 6], amounts: { DLXK: 320000 } }),
    );
  });

  // Picking every weekday is the same as picking none.
  it('요일 7개는 매일로 바꿔 보낸다', async () => {
    const prisma = buildPrisma();
    const core = buildCore();
    const service = await buildService(prisma, core);

    await service.addSeason('BAR', { ...SEASON, daysOfWeek: [0, 1, 2, 3, 4, 5, 6] }, ACTOR);

    expect(core.addRateSeason.mock.calls[0][1].daysOfWeek).toBeUndefined();
  });

  it('요일이 중복되면 거절한다', async () => {
    const prisma = buildPrisma();
    const service = await buildService(prisma);

    await expect(
      service.addSeason('BAR', { ...SEASON, daysOfWeek: [5, 5] }, ACTOR),
    ).rejects.toMatchObject({ response: { code: 'RATE_WEEKDAY_DUPLICATE' } });
  });

  it('종료일이 시작일보다 앞서면 거절한다', async () => {
    const prisma = buildPrisma();
    const core = buildCore();
    const service = await buildService(prisma, core);

    await expect(
      service.addSeason(
        'BAR',
        { ...SEASON, startDate: '2026-08-20', endDate: '2026-07-15' },
        ACTOR,
      ),
    ).rejects.toMatchObject({ response: { code: 'END_BEFORE_START' } });
    expect(core.addRateSeason).not.toHaveBeenCalled();
  });

  it('삭제는 호텔 코드와 함께 보낸다', async () => {
    const prisma = buildPrisma();
    const core = buildCore();
    const service = await buildService(prisma, core);

    await service.removeSeason('BAR', 'SEA-1', undefined, ACTOR);

    expect(core.removeRateSeason).toHaveBeenCalledWith('BAR', 'SEA-1', 'SAND01');
  });
});

describe('RatesService — 기록', () => {
  it('설정 변경은 성공으로 남는다', async () => {
    const prisma = buildPrisma();
    const service = await buildService(prisma);

    await service.createPlan({ ...NEW_PLAN }, ACTOR);

    expect(prisma.syncLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ entity: 'RatePlan', entityId: 'promo' }),
      }),
    );
    expect(prisma.syncLog.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'SUCCESS' }) }),
    );
  });

  // Without recording the failure there is no telling later why the rate did not change.
  it('실패도 남기고 오류를 그대로 올린다', async () => {
    const prisma = buildPrisma();
    const core = buildCore({
      createRatePlan: jest.fn().mockRejectedValue(new Error('이미 쓰고 있는 요금 코드입니다')),
    });
    const service = await buildService(prisma, core);

    await expect(service.createPlan({ ...NEW_PLAN }, ACTOR)).rejects.toThrow(/이미 쓰고 있는/);
    expect(prisma.syncLog.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'FAILED',
          error: '이미 쓰고 있는 요금 코드입니다',
        }),
      }),
    );
  });
});

describe('RatesService — 패키지', () => {
  it('코드를 대문자로 보낸다', async () => {
    const prisma = buildPrisma();
    const core = buildCore();
    const service = await buildService(prisma, core);

    await service.createPackage(
      {
        packageCode: 'bfast',
        name: ' 조식 ',
        amount: 25000,
        calculation: 'PerPerson',
        transactionCode: ' 2000 ',
      },
      ACTOR,
    );

    expect(core.createPackage).toHaveBeenCalledWith(
      expect.objectContaining({ packageCode: 'BFAST', name: '조식', transactionCode: '2000' }),
    );
  });

  it('수정은 보낸 항목만 넘긴다', async () => {
    const prisma = buildPrisma();
    const core = buildCore();
    const service = await buildService(prisma, core);

    await service.updatePackage('BFAST', { amount: 30000 }, ACTOR);

    const sent = core.updatePackage.mock.calls[0][1];
    expect(sent.amount).toBe(30000);
    expect(sent.name).toBeUndefined();
  });
});
