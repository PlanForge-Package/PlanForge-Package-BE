import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PaymentMethod, PostingType, Prisma, UserRole } from '@prisma/client';
import { CoreClient } from '../core/core.client';
import { PrismaService } from '../prisma/prisma.service';
import { JournalService } from './journal.service';

const ACTOR = {
  id: 'user-1',
  sub: 'user-1',
  email: 'manager@planforge.local',
  name: '지배인',
  role: UserRole.MANAGER,
  propertyId: 'prop-1',
} as const;

const CODES = [
  {
    transactionCode: '1000',
    hotelId: 'SAND01',
    name: '객실료',
    group: 'Room',
    vatRate: 0.1,
    serviceChargeRate: 0,
    taxInclusive: true,
    active: true,
  },
  {
    transactionCode: '2000',
    hotelId: 'SAND01',
    name: '조식',
    group: 'FoodBeverage',
    vatRate: 0.1,
    serviceChargeRate: 0.1,
    taxInclusive: true,
    active: true,
  },
  {
    transactionCode: '5000',
    hotelId: 'SAND01',
    name: '결제',
    group: 'Payment',
    vatRate: 0,
    serviceChargeRate: 0,
    taxInclusive: false,
    active: true,
  },
];

function posting(transactionCode: string, amount: number, type: PostingType = PostingType.CHARGE) {
  return { transactionCode, type, amount: new Prisma.Decimal(amount) };
}

function buildPrisma(overrides: Record<string, unknown> = {}) {
  return {
    property: {
      findUnique: jest
        .fn()
        .mockResolvedValue({ id: 'prop-1', operaHotelId: 'SAND01', currency: 'KRW' }),
      ...((overrides.property as object) ?? {}),
    },
    posting: {
      findMany: jest.fn().mockResolvedValue([]),
      aggregate: jest.fn().mockResolvedValue({ _sum: { amount: new Prisma.Decimal(0) } }),
      ...((overrides.posting as object) ?? {}),
    },
    payment: {
      findMany: jest.fn().mockResolvedValue([]),
      ...((overrides.payment as object) ?? {}),
    },
    folio: {
      aggregate: jest.fn().mockResolvedValue({ _sum: { balance: new Prisma.Decimal(0) } }),
      ...((overrides.folio as object) ?? {}),
    },
  };
}

function buildCore(items = CODES) {
  return {
    listTransactionCodes: jest.fn().mockResolvedValue({ hotelId: 'SAND01', items }),
  };
}

async function buildService(
  prisma: ReturnType<typeof buildPrisma>,
  core: ReturnType<typeof buildCore> = buildCore(),
) {
  const moduleRef = await Test.createTestingModule({
    providers: [
      JournalService,
      { provide: PrismaService, useValue: prisma },
      { provide: CoreClient, useValue: core },
    ],
  }).compile();
  return moduleRef.get(JournalService);
}

const QUERY = { date: '2026-08-04' };

describe('JournalService — 세금 분해', () => {
  // 220,000 = 공급가액 200,000 + 부가세 20,000. 봉사료는 객실에 붙지 않는다.
  it('부가세만 붙는 코드는 공급가액과 부가세로 나뉜다', async () => {
    const prisma = buildPrisma({
      posting: {
        findMany: jest.fn().mockResolvedValue([posting('1000', 220000)]),
        aggregate: jest.fn().mockResolvedValue({ _sum: { amount: new Prisma.Decimal(0) } }),
      },
    });
    const service = await buildService(prisma);

    const result = await service.daily(QUERY, ACTOR);
    const room = result.revenue.groups.find((g) => g.group === 'Room');

    expect(room?.net).toBe('200000.00');
    expect(room?.vat).toBe('20000.00');
    expect(room?.serviceCharge).toBe('0.00');
  });

  // 봉사료가 먼저 붙고 그 합에 부가세가 붙는다: 100,000 × 1.1 × 1.1 = 121,000.
  it('봉사료가 있는 코드는 봉사료·부가세를 갈라낸다', async () => {
    const prisma = buildPrisma({
      posting: {
        findMany: jest.fn().mockResolvedValue([posting('2000', 121000)]),
        aggregate: jest.fn().mockResolvedValue({ _sum: { amount: new Prisma.Decimal(0) } }),
      },
    });
    const service = await buildService(prisma);

    const result = await service.daily(QUERY, ACTOR);
    const fnb = result.revenue.groups.find((g) => g.group === 'FoodBeverage');

    expect(fnb?.net).toBe('100000.00');
    expect(fnb?.serviceCharge).toBe('10000.00');
    expect(fnb?.vat).toBe('11000.00');
  });

  // 1원이라도 어긋나면 마감이 안 맞는다.
  it('나눈 값의 합은 언제나 표시가격과 같다', async () => {
    const prisma = buildPrisma({
      posting: {
        findMany: jest.fn().mockResolvedValue([posting('1000', 33333), posting('2000', 77777)]),
        aggregate: jest.fn().mockResolvedValue({ _sum: { amount: new Prisma.Decimal(0) } }),
      },
    });
    const service = await buildService(prisma);

    const result = await service.daily(QUERY, ACTOR);
    const total = result.revenue.total;

    expect(Number(total.net) + Number(total.serviceCharge) + Number(total.vat)).toBe(
      Number(total.gross),
    );
    expect(Number(total.gross)).toBe(111110);
  });

  it('설정에 없는 코드는 나누지 않고 표시한다', async () => {
    const prisma = buildPrisma({
      posting: {
        findMany: jest.fn().mockResolvedValue([posting('8888', 50000)]),
        aggregate: jest.fn().mockResolvedValue({ _sum: { amount: new Prisma.Decimal(0) } }),
      },
    });
    const service = await buildService(prisma);

    const result = await service.daily(QUERY, ACTOR);

    expect(result.unmappedCodes).toEqual(['8888']);
    expect(result.revenue.total.net).toBe('50000.00');
    expect(result.revenue.total.vat).toBe('0.00');
  });

  it('마이너스 조정도 그대로 반영한다', async () => {
    const prisma = buildPrisma({
      posting: {
        findMany: jest
          .fn()
          .mockResolvedValue([
            posting('1000', 220000),
            posting('1000', -110000, PostingType.ADJUSTMENT),
          ]),
        aggregate: jest.fn().mockResolvedValue({ _sum: { amount: new Prisma.Decimal(0) } }),
      },
    });
    const service = await buildService(prisma);

    const result = await service.daily(QUERY, ACTOR);

    expect(result.revenue.total.gross).toBe('110000.00');
    expect(result.revenue.total.net).toBe('100000.00');
  });
});

describe('JournalService — 매출과 결제', () => {
  // 결제를 매출로 세면 매출이 결제만큼 깎인다.
  it('결제 포스팅은 매출에 넣지 않는다', async () => {
    const prisma = buildPrisma({
      posting: {
        findMany: jest
          .fn()
          .mockResolvedValue([
            posting('1000', 220000),
            posting('5000', -220000, PostingType.PAYMENT),
          ]),
        aggregate: jest.fn().mockResolvedValue({ _sum: { amount: new Prisma.Decimal(0) } }),
      },
    });
    const service = await buildService(prisma);

    const result = await service.daily(QUERY, ACTOR);

    expect(result.revenue.total.gross).toBe('220000.00');
    expect(result.ledger.charges).toBe('220000.00');
    expect(result.ledger.payments).toBe('220000.00');
  });

  it('수단별 수납을 모으고 환불한 만큼 뺀다', async () => {
    const prisma = buildPrisma({
      payment: {
        findMany: jest.fn().mockResolvedValue([
          {
            method: PaymentMethod.CARD,
            amount: new Prisma.Decimal(100000),
            refundedAmount: new Prisma.Decimal(30000),
          },
          {
            method: PaymentMethod.CASH,
            amount: new Prisma.Decimal(50000),
            refundedAmount: new Prisma.Decimal(0),
          },
        ]),
      },
    });
    const service = await buildService(prisma);

    const result = await service.daily(QUERY, ACTOR);
    const card = result.payments.methods.find((m) => m.method === 'CARD');

    expect(card?.amount).toBe('70000.00');
    expect(result.payments.total).toBe('120000.00');
  });
});

describe('JournalService — 대사', () => {
  it('전일 잔액 + 청구 − 수납이 마감 잔액이다', async () => {
    const prisma = buildPrisma({
      posting: {
        findMany: jest
          .fn()
          .mockResolvedValue([
            posting('1000', 220000),
            posting('5000', -100000, PostingType.PAYMENT),
          ]),
        aggregate: jest.fn().mockResolvedValue({ _sum: { amount: new Prisma.Decimal(50000) } }),
      },
      folio: {
        aggregate: jest.fn().mockResolvedValue({ _sum: { balance: new Prisma.Decimal(170000) } }),
      },
    });
    const service = await buildService(prisma);

    const result = await service.daily(QUERY, ACTOR);

    expect(result.ledger.openingBalance).toBe('50000.00');
    expect(result.ledger.closingBalance).toBe('170000.00');
    expect(result.ledger.balanced).toBe(true);
  });

  // 다르면 어딘가 포스팅이 새고 있다는 뜻이다. 숨기지 않고 드러낸다.
  it('열린 폴리오 잔액과 다르면 어긋났다고 알린다', async () => {
    const prisma = buildPrisma({
      posting: {
        findMany: jest.fn().mockResolvedValue([posting('1000', 220000)]),
        aggregate: jest.fn().mockResolvedValue({ _sum: { amount: new Prisma.Decimal(0) } }),
      },
      folio: {
        aggregate: jest.fn().mockResolvedValue({ _sum: { balance: new Prisma.Decimal(1) } }),
      },
    });
    const service = await buildService(prisma);

    const result = await service.daily(QUERY, ACTOR);

    expect(result.ledger.balanced).toBe(false);
    expect(result.ledger.outstanding).toBe('1.00');
  });

  it('포스팅이 없으면 0 으로 맞는다', async () => {
    const prisma = buildPrisma();
    const service = await buildService(prisma);

    const result = await service.daily(QUERY, ACTOR);

    expect(result.revenue.total.count).toBe(0);
    expect(result.ledger.balanced).toBe(true);
  });
});

describe('JournalService — 범위', () => {
  it('호텔을 고르지 않으면 거절한다', async () => {
    const prisma = buildPrisma();
    const service = await buildService(prisma);
    const hq = { ...ACTOR, propertyId: null };

    await expect(service.daily(QUERY, hq)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('없는 호텔은 404 를 낸다', async () => {
    const prisma = buildPrisma({ property: { findUnique: jest.fn().mockResolvedValue(null) } });
    const service = await buildService(prisma);

    await expect(service.daily(QUERY, ACTOR)).rejects.toBeInstanceOf(NotFoundException);
  });

  // 지난 마감에는 지금 중지한 코드가 남아 있다. 이름 없이 숫자만 남으면 못 읽는다.
  it('중지한 거래 코드까지 읽어 온다', async () => {
    const prisma = buildPrisma();
    const core = buildCore();
    const service = await buildService(prisma, core);

    await service.daily(QUERY, ACTOR);

    expect(core.listTransactionCodes).toHaveBeenCalledWith('SAND01', true);
  });
});
