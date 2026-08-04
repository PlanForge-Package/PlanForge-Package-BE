import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PaymentMethod, PaymentStatus, Prisma, UserRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CashierService } from './cashier.service';

const ACTOR = {
  id: 'user-1',
  sub: 'user-1',
  email: 'front@planforge.local',
  name: '프런트',
  role: UserRole.FRONT_DESK,
  propertyId: 'prop-1',
} as const;

function shift(overrides: Record<string, unknown> = {}) {
  return {
    id: 'shift-1',
    propertyId: 'prop-1',
    userId: 'user-1',
    openedAt: new Date('2026-08-04T09:00:00Z'),
    closedAt: null,
    openingFloat: new Prisma.Decimal(100000),
    countedCash: null,
    notes: null,
    ...overrides,
  };
}

function payment(method: PaymentMethod, amount: number, refunded = 0) {
  return {
    method,
    amount: new Prisma.Decimal(amount),
    refundedAmount: new Prisma.Decimal(refunded),
  };
}

function buildPrisma(overrides: Record<string, unknown> = {}) {
  return {
    property: { findUnique: jest.fn().mockResolvedValue({ id: 'prop-1' }) },
    cashierShift: {
      findFirst: jest.fn().mockResolvedValue(null),
      findUnique: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockImplementation(({ data }) => shift(data)),
      update: jest.fn().mockImplementation(({ data }) => shift({ ...data })),
      ...((overrides.cashierShift as object) ?? {}),
    },
    payment: {
      findMany: jest.fn().mockResolvedValue([]),
      ...((overrides.payment as object) ?? {}),
    },
  };
}

async function buildService(prisma: ReturnType<typeof buildPrisma>) {
  const moduleRef = await Test.createTestingModule({
    providers: [CashierService, { provide: PrismaService, useValue: prisma }],
  }).compile();
  return moduleRef.get(CashierService);
}

describe('CashierService — 근무조 개설', () => {
  it('시작 시재와 함께 연다', async () => {
    const prisma = buildPrisma();
    const service = await buildService(prisma);

    await service.open({ propertyId: 'prop-1', openingFloat: 100000 }, ACTOR);

    const created = prisma.cashierShift.create.mock.calls[0][0].data;
    expect(created.userId).toBe('user-1');
    expect(created.openingFloat.toString()).toBe('100000');
  });

  /*
   * 열려 있는데 또 열면 수납이 어느 조에 붙는지 정할 수 없고, 마감 금액이 두
   * 조로 나뉜다.
   */
  it('이미 열린 조가 있으면 거절한다', async () => {
    const prisma = buildPrisma({
      cashierShift: { findFirst: jest.fn().mockResolvedValue({ id: 'shift-0' }) },
    });
    const service = await buildService(prisma);

    await expect(service.open({ propertyId: 'prop-1' }, ACTOR)).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('호텔을 고르지 않으면 거절한다', async () => {
    const prisma = buildPrisma();
    const service = await buildService(prisma);
    const hq = { ...ACTOR, propertyId: null };

    await expect(service.open({}, hq)).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('CashierService — 집계', () => {
  it('수단별로 나눠 센다', async () => {
    const prisma = buildPrisma({
      cashierShift: { findFirst: jest.fn().mockResolvedValue(shift()) },
      payment: {
        findMany: jest
          .fn()
          .mockResolvedValue([
            payment(PaymentMethod.CASH, 50000),
            payment(PaymentMethod.CARD, 240000),
            payment(PaymentMethod.TRANSFER, 30000),
          ]),
      },
    });
    const service = await buildService(prisma);

    const { summary } = await service.current(ACTOR);

    expect(summary?.byMethod).toEqual({
      CASH: '50000.00',
      CARD: '240000.00',
      TRANSFER: '30000.00',
    });
    expect(summary?.collected).toBe('320000.00');
  });

  // 환불한 만큼 금고에서 나갔다.
  it('환불한 금액은 빼고 센다', async () => {
    const prisma = buildPrisma({
      cashierShift: { findFirst: jest.fn().mockResolvedValue(shift()) },
      payment: {
        findMany: jest.fn().mockResolvedValue([payment(PaymentMethod.CASH, 50000, 20000)]),
      },
    });
    const service = await buildService(prisma);

    const { summary } = await service.current(ACTOR);
    expect(summary?.byMethod.CASH).toBe('30000.00');
  });

  // 매입 전에는 아직 우리 돈이 아니다.
  it('승인만 된 결제는 집계에서 뺀다', async () => {
    const prisma = buildPrisma({
      cashierShift: { findFirst: jest.fn().mockResolvedValue(shift()) },
    });
    const service = await buildService(prisma);

    await service.current(ACTOR);

    expect(prisma.payment.findMany.mock.calls[0][0].where.status).toEqual({
      in: [PaymentStatus.CAPTURED, PaymentStatus.REFUNDED],
    });
  });

  it('있어야 할 현금은 시작 시재에 받은 현금을 더한 값이다', async () => {
    const prisma = buildPrisma({
      cashierShift: { findFirst: jest.fn().mockResolvedValue(shift()) },
      payment: { findMany: jest.fn().mockResolvedValue([payment(PaymentMethod.CASH, 50000)]) },
    });
    const service = await buildService(prisma);

    const { summary } = await service.current(ACTOR);
    expect(summary?.expectedCash).toBe('150000.00');
  });

  it('마감 전에는 센 현금과 차이가 비어 있다', async () => {
    const prisma = buildPrisma({
      cashierShift: { findFirst: jest.fn().mockResolvedValue(shift()) },
    });
    const service = await buildService(prisma);

    const { summary } = await service.current(ACTOR);
    expect(summary?.countedCash).toBeNull();
    expect(summary?.difference).toBeNull();
  });

  it('열린 조가 없으면 null 을 돌려준다', async () => {
    const prisma = buildPrisma();
    const service = await buildService(prisma);

    expect(await service.current(ACTOR)).toEqual({ shift: null, summary: null });
  });
});

describe('CashierService — 마감', () => {
  it('센 현금과 있어야 할 현금의 차이를 낸다', async () => {
    const prisma = buildPrisma({
      cashierShift: {
        findUnique: jest.fn().mockResolvedValue(shift()),
        update: jest
          .fn()
          .mockResolvedValue(
            shift({ closedAt: new Date(), countedCash: new Prisma.Decimal(145000) }),
          ),
      },
      payment: { findMany: jest.fn().mockResolvedValue([payment(PaymentMethod.CASH, 50000)]) },
    });
    const service = await buildService(prisma);

    const { summary } = await service.close('shift-1', { countedCash: 145000 }, ACTOR);

    // 있어야 할 150,000 인데 145,000 을 셌다 — 5,000 부족.
    expect(summary.expectedCash).toBe('150000.00');
    expect(summary.difference).toBe('-5000.00');
  });

  it('남는 현금은 양수로 낸다', async () => {
    const prisma = buildPrisma({
      cashierShift: {
        findUnique: jest.fn().mockResolvedValue(shift()),
        update: jest
          .fn()
          .mockResolvedValue(
            shift({ closedAt: new Date(), countedCash: new Prisma.Decimal(103000) }),
          ),
      },
    });
    const service = await buildService(prisma);

    const { summary } = await service.close('shift-1', { countedCash: 103000 }, ACTOR);
    expect(summary.difference).toBe('3000.00');
  });

  /*
   * 막으면 맞을 때까지 아무도 마감하지 않고, 다음 조의 수납이 이 조에 섞인다.
   * 차이는 숨기지 말고 기록해서 다음 날 확인하게 하는 편이 낫다.
   */
  it('차이가 나도 마감을 막지 않는다', async () => {
    const prisma = buildPrisma({
      cashierShift: {
        findUnique: jest.fn().mockResolvedValue(shift()),
        update: jest
          .fn()
          .mockResolvedValue(shift({ closedAt: new Date(), countedCash: new Prisma.Decimal(0) })),
      },
    });
    const service = await buildService(prisma);

    await expect(service.close('shift-1', { countedCash: 0 }, ACTOR)).resolves.toBeDefined();
  });

  it('메모를 남긴다', async () => {
    const prisma = buildPrisma({
      cashierShift: { findUnique: jest.fn().mockResolvedValue(shift()) },
    });
    const service = await buildService(prisma);

    await service.close('shift-1', { countedCash: 150000, notes: '5천원 부족 — 확인 중' }, ACTOR);

    expect(prisma.cashierShift.update.mock.calls[0][0].data.notes).toBe('5천원 부족 — 확인 중');
  });

  // 남의 조를 마감하면 그 사람은 자기가 받은 돈을 확인할 기회를 잃는다.
  it('남의 근무조는 마감할 수 없다', async () => {
    const prisma = buildPrisma({
      cashierShift: { findUnique: jest.fn().mockResolvedValue(shift({ userId: 'user-9' })) },
    });
    const service = await buildService(prisma);

    await expect(service.close('shift-1', { countedCash: 0 }, ACTOR)).rejects.toThrow(
      /자기 근무조만/,
    );
  });

  it('이미 마감된 조는 다시 마감하지 않는다', async () => {
    const prisma = buildPrisma({
      cashierShift: { findUnique: jest.fn().mockResolvedValue(shift({ closedAt: new Date() })) },
    });
    const service = await buildService(prisma);

    await expect(service.close('shift-1', { countedCash: 0 }, ACTOR)).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('없는 근무조는 404 를 낸다', async () => {
    const prisma = buildPrisma();
    const service = await buildService(prisma);

    await expect(service.close('nope', { countedCash: 0 }, ACTOR)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('다른 호텔의 근무조는 막는다', async () => {
    const prisma = buildPrisma({
      cashierShift: { findUnique: jest.fn().mockResolvedValue(shift({ propertyId: 'prop-9' })) },
    });
    const service = await buildService(prisma);

    await expect(service.close('shift-1', { countedCash: 0 }, ACTOR)).rejects.toThrow(
      /접근할 수 없습니다/,
    );
  });
});
