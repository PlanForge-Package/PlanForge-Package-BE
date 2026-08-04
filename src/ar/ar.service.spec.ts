import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ArInvoiceStatus, ArTransactionType, FolioStatus, Prisma, UserRole } from '@prisma/client';
import { CoreClient } from '../core/core.client';
import { PrismaService } from '../prisma/prisma.service';
import { ArService } from './ar.service';

// 미러링은 folio-mirror.spec.ts 가 따로 본다.
jest.mock('../folios/folio-mirror', () => ({
  ...jest.requireActual('../folios/folio-mirror'),
  mirrorFolios: jest.fn().mockResolvedValue(undefined),
}));

const ACTOR = {
  id: 'user-1',
  sub: 'user-1',
  email: 'manager@planforge.local',
  name: '지배인',
  role: UserRole.MANAGER,
  propertyId: 'prop-1',
} as const;

function account(overrides: Record<string, unknown> = {}) {
  return {
    id: 'acc-1',
    propertyId: 'prop-1',
    code: 'SPACEPL',
    name: '스페이스플래닝',
    creditLimit: null as Prisma.Decimal | null,
    termDays: 30,
    active: true,
    ...overrides,
  };
}

function reservation(overrides: Record<string, unknown> = {}) {
  return {
    id: 'res-1',
    propertyId: 'prop-1',
    operaReservationId: 'OPERA-2001',
    confirmationNumber: 'OP2001',
    currency: 'KRW',
    property: { operaHotelId: 'SAND01' },
    ...overrides,
  };
}

function folio(overrides: Record<string, unknown> = {}) {
  return {
    id: 'fol-1',
    reservationId: 'res-1',
    window: 1,
    status: FolioStatus.OPEN,
    balance: new Prisma.Decimal(240000),
    currency: 'KRW',
    ...overrides,
  };
}

function buildPrisma(overrides: Record<string, unknown> = {}) {
  const tx = {
    arTransaction: {
      create: jest.fn().mockImplementation(({ data }) => ({ id: 'tx-1', ...data })),
      updateMany: jest.fn(),
    },
    arInvoice: {
      create: jest.fn().mockImplementation(({ data }) => ({ id: 'inv-1', ...data })),
      update: jest.fn().mockImplementation(({ data }) => ({ id: 'inv-1', ...data })),
    },
  };

  return {
    tx,
    arAccount: {
      findUnique: jest.fn().mockResolvedValue(account()),
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockImplementation(({ data }) => ({ id: 'acc-new', ...data })),
      update: jest.fn().mockImplementation(({ data }) => ({ id: 'acc-1', ...data })),
      ...((overrides.arAccount as object) ?? {}),
    },
    arTransaction: {
      findMany: jest.fn().mockResolvedValue([]),
      aggregate: jest.fn().mockResolvedValue({ _sum: { amount: new Prisma.Decimal(0) } }),
      groupBy: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockImplementation(({ data }) => ({ id: 'tx-1', ...data })),
      ...((overrides.arTransaction as object) ?? {}),
    },
    arInvoice: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(null),
      findUnique: jest.fn().mockResolvedValue(null),
      ...((overrides.arInvoice as object) ?? {}),
    },
    reservation: {
      findUnique: jest.fn().mockResolvedValue(reservation()),
      ...((overrides.reservation as object) ?? {}),
    },
    folio: {
      findUnique: jest.fn().mockResolvedValue(folio()),
      ...((overrides.folio as object) ?? {}),
    },
    $transaction: jest.fn((cb: (client: typeof tx) => unknown) => cb(tx)),
  };
}

function buildCore(overrides: Record<string, unknown> = {}) {
  return {
    createPosting: jest.fn().mockResolvedValue({
      folioId: 'FOL-801',
      reservationId: 'OPERA-2001',
      window: 1,
      status: 'Open',
      balance: 0,
      currencyCode: 'KRW',
      postings: [],
    }),
    ...overrides,
  };
}

async function buildService(
  prisma: ReturnType<typeof buildPrisma>,
  core: ReturnType<typeof buildCore> = buildCore(),
) {
  const moduleRef = await Test.createTestingModule({
    providers: [
      ArService,
      { provide: PrismaService, useValue: prisma },
      { provide: CoreClient, useValue: core },
    ],
  }).compile();
  return moduleRef.get(ArService);
}

const TRANSFER = { accountId: 'acc-1', window: 1 };

describe('ArService — 거래처', () => {
  it('코드를 대문자로 맞춰 만든다', async () => {
    const prisma = buildPrisma({ arAccount: { findUnique: jest.fn().mockResolvedValue(null) } });
    const service = await buildService(prisma);

    await service.createAccount(
      { propertyId: 'prop-1', code: ' spacepl ', name: ' 스페이스 ' },
      ACTOR,
    );

    const created = prisma.arAccount.create.mock.calls[0][0].data;
    expect(created.code).toBe('SPACEPL');
    expect(created.name).toBe('스페이스');
  });

  it('같은 코드는 두 번 만들지 않는다', async () => {
    const prisma = buildPrisma();
    const service = await buildService(prisma);

    await expect(
      service.createAccount({ propertyId: 'prop-1', code: 'SPACEPL', name: 'x' }, ACTOR),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('호텔을 고르지 않으면 거절한다', async () => {
    const prisma = buildPrisma();
    const service = await buildService(prisma);
    const hq = { ...ACTOR, propertyId: null };

    await expect(service.createAccount({ code: 'A', name: 'B' }, hq)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('다른 호텔의 거래처는 막는다', async () => {
    const prisma = buildPrisma({
      arAccount: { findUnique: jest.fn().mockResolvedValue(account({ propertyId: 'prop-9' })) },
    });
    const service = await buildService(prisma);

    await expect(service.accountDetail('acc-1', ACTOR)).rejects.toThrow(/접근할 수 없습니다/);
  });
});

describe('ArService — 폴리오 이관', () => {
  /*
   * 폴리오만 비우고 원장에 올리지 않으면 받을 돈이 사라지고, 원장에만 올리고
   * 폴리오를 두면 손님이 체크아웃하지 못한다.
   */
  it('OPERA 폴리오를 비우고 원장에 청구로 올린다', async () => {
    const prisma = buildPrisma();
    const core = buildCore();
    const service = await buildService(prisma, core);

    await service.transferFolio('res-1', TRANSFER, ACTOR);

    expect(core.createPosting).toHaveBeenCalledWith(
      'OPERA-2001',
      1,
      expect.objectContaining({ type: 'Payment', amount: 240000, reference: 'AR-fol-1' }),
    );
    const created = prisma.tx.arTransaction.create.mock.calls[0][0].data;
    expect(created.type).toBe(ArTransactionType.CHARGE);
    expect(created.amount.toString()).toBe('240000');
    expect(created.reservationId).toBe('res-1');
  });

  // 같은 창구를 두 번 넘기면 거래처에 두 배로 청구된다.
  it('같은 창구는 같은 전표 번호로 넘긴다', async () => {
    const prisma = buildPrisma();
    const core = buildCore();
    const service = await buildService(prisma, core);

    await service.transferFolio('res-1', TRANSFER, ACTOR);
    expect(core.createPosting.mock.calls[0][2].reference).toBe('AR-fol-1');
  });

  it('OPERA 가 거절하면 원장에 올리지 않는다', async () => {
    const prisma = buildPrisma();
    const core = buildCore({
      createPosting: jest.fn().mockRejectedValue(new BadRequestException('이미 마감')),
    });
    const service = await buildService(prisma, core);

    await expect(service.transferFolio('res-1', TRANSFER, ACTOR)).rejects.toThrow(/이미 마감/);
    expect(prisma.tx.arTransaction.create).not.toHaveBeenCalled();
  });

  it('잔액이 없으면 넘기지 않는다', async () => {
    const prisma = buildPrisma({
      folio: { findUnique: jest.fn().mockResolvedValue(folio({ balance: new Prisma.Decimal(0) })) },
    });
    const core = buildCore();
    const service = await buildService(prisma, core);

    await expect(service.transferFolio('res-1', TRANSFER, ACTOR)).rejects.toThrow(
      /넘길 잔액이 없습니다/,
    );
    expect(core.createPosting).not.toHaveBeenCalled();
  });

  // 음수면 거래처가 아니라 손님에게 돌려줄 돈이다.
  it('마이너스 잔액은 넘기지 않는다', async () => {
    const prisma = buildPrisma({
      folio: {
        findUnique: jest.fn().mockResolvedValue(folio({ balance: new Prisma.Decimal(-1000) })),
      },
    });
    const service = await buildService(prisma);

    await expect(service.transferFolio('res-1', TRANSFER, ACTOR)).rejects.toThrow(
      /넘길 잔액이 없습니다/,
    );
  });

  it('마감된 폴리오는 넘기지 않는다', async () => {
    const prisma = buildPrisma({
      folio: { findUnique: jest.fn().mockResolvedValue(folio({ status: FolioStatus.CLOSED })) },
    });
    const service = await buildService(prisma);

    await expect(service.transferFolio('res-1', TRANSFER, ACTOR)).rejects.toThrow(/마감된 폴리오/);
  });

  // 중지한 거래처로 넘기면 청구할 곳 없는 미수가 쌓인다.
  it('중지된 거래처로는 넘기지 않는다', async () => {
    const prisma = buildPrisma({
      arAccount: { findUnique: jest.fn().mockResolvedValue(account({ active: false })) },
    });
    const service = await buildService(prisma);

    await expect(service.transferFolio('res-1', TRANSFER, ACTOR)).rejects.toThrow(/중지된 거래처/);
  });

  it('다른 호텔의 거래처로는 넘기지 않는다', async () => {
    const prisma = buildPrisma({
      arAccount: { findUnique: jest.fn().mockResolvedValue(account({ propertyId: 'prop-2' })) },
    });
    const service = await buildService(prisma);
    const hq = { ...ACTOR, propertyId: null };

    await expect(service.transferFolio('res-1', TRANSFER, hq)).rejects.toThrow(/다른 호텔/);
  });

  /*
   * 한도는 "이만큼까지는 받아 주겠다" 는 약속이다. 넘긴 뒤에 알면 이미 손님은
   * 나갔고 청구할 수 없는 금액이 남는다.
   */
  it('여신 한도를 넘으면 막는다', async () => {
    const prisma = buildPrisma({
      arAccount: {
        findUnique: jest
          .fn()
          .mockResolvedValue(account({ creditLimit: new Prisma.Decimal(300000) })),
      },
      arTransaction: {
        aggregate: jest.fn().mockResolvedValue({ _sum: { amount: new Prisma.Decimal(100000) } }),
      },
    });
    const core = buildCore();
    const service = await buildService(prisma, core);

    await expect(service.transferFolio('res-1', TRANSFER, ACTOR)).rejects.toThrow(/여신 한도/);
    expect(core.createPosting).not.toHaveBeenCalled();
  });

  it('한도 안이면 넘긴다', async () => {
    const prisma = buildPrisma({
      arAccount: {
        findUnique: jest
          .fn()
          .mockResolvedValue(account({ creditLimit: new Prisma.Decimal(500000) })),
      },
      arTransaction: {
        aggregate: jest.fn().mockResolvedValue({ _sum: { amount: new Prisma.Decimal(100000) } }),
      },
    });
    const service = await buildService(prisma);

    await expect(service.transferFolio('res-1', TRANSFER, ACTOR)).resolves.toBeDefined();
  });

  it('OPERA 에 연결되지 않은 예약은 막는다', async () => {
    const prisma = buildPrisma({
      reservation: {
        findUnique: jest.fn().mockResolvedValue(reservation({ operaReservationId: null })),
      },
    });
    const core = buildCore();
    const service = await buildService(prisma, core);

    await expect(service.transferFolio('res-1', TRANSFER, ACTOR)).rejects.toThrow(/동기화/);
    expect(core.createPosting).not.toHaveBeenCalled();
  });
});

describe('ArService — 입금', () => {
  // 잔액이 곧 거래 합계이기 때문이다.
  it('입금은 음수로 올라간다', async () => {
    const prisma = buildPrisma();
    const service = await buildService(prisma);

    await service.recordPayment('acc-1', { amount: 50000, description: '10월분' }, ACTOR);

    const created = prisma.arTransaction.create.mock.calls[0][0].data;
    expect(created.amount.toString()).toBe('-50000');
    expect(created.type).toBe(ArTransactionType.PAYMENT);
  });

  // 입금을 미청구로 세면 다음 달 청구서가 지난달 입금만큼 깎인다.
  it('미청구 금액에 입금은 세지 않는다', async () => {
    const prisma = buildPrisma();
    const service = await buildService(prisma);

    await service.accountDetail('acc-1', ACTOR);

    expect(prisma.arTransaction.aggregate).toHaveBeenCalledWith({
      where: { accountId: 'acc-1', invoiceId: null, type: { not: ArTransactionType.PAYMENT } },
      _sum: { amount: true },
    });
  });
});

describe('ArService — 청구서', () => {
  const UNBILLED = [
    { id: 'tx-1', amount: new Prisma.Decimal(240000) },
    { id: 'tx-2', amount: new Prisma.Decimal(160000) },
  ];

  it('미청구 거래를 모아 발행한다', async () => {
    const prisma = buildPrisma({
      arTransaction: { findMany: jest.fn().mockResolvedValue(UNBILLED) },
    });
    const service = await buildService(prisma);

    await service.createInvoice('acc-1', {}, ACTOR);

    const created = prisma.tx.arInvoice.create.mock.calls[0][0].data;
    expect(created.total.toString()).toBe('400000');
    expect(created.number).toMatch(/^INV-\d{4}-0001$/);
  });

  // 입금은 청구하는 것이 아니라 청구한 것을 갚는 것이다. 쓸어 담으면 두 번 깎인다.
  it('입금은 청구서에 담지 않는다', async () => {
    const prisma = buildPrisma({
      arTransaction: { findMany: jest.fn().mockResolvedValue(UNBILLED) },
    });
    const service = await buildService(prisma);

    await service.createInvoice('acc-1', {}, ACTOR);

    expect(prisma.arTransaction.findMany).toHaveBeenCalledWith({
      where: { accountId: 'acc-1', invoiceId: null, type: { not: ArTransactionType.PAYMENT } },
      select: { id: true, amount: true },
    });
  });

  // 두 번 청구하면 거래처가 두 번 낸다.
  it('발행한 거래를 청구서에 묶는다', async () => {
    const prisma = buildPrisma({
      arTransaction: { findMany: jest.fn().mockResolvedValue(UNBILLED) },
    });
    const service = await buildService(prisma);

    await service.createInvoice('acc-1', {}, ACTOR);

    expect(prisma.tx.arTransaction.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['tx-1', 'tx-2'] } },
      data: { invoiceId: 'inv-1' },
    });
  });

  it('결제 조건으로 만기일을 계산한다', async () => {
    const prisma = buildPrisma({
      arAccount: { findUnique: jest.fn().mockResolvedValue(account({ termDays: 10 })) },
      arTransaction: { findMany: jest.fn().mockResolvedValue(UNBILLED) },
    });
    const service = await buildService(prisma);

    await service.createInvoice('acc-1', {}, ACTOR);

    const due = prisma.tx.arInvoice.create.mock.calls[0][0].data.dueDate as Date;
    const expected = new Date();
    expected.setUTCDate(expected.getUTCDate() + 10);
    expect(due.toISOString().slice(0, 10)).toBe(expected.toISOString().slice(0, 10));
  });

  it('청구할 거래가 없으면 만들지 않는다', async () => {
    const prisma = buildPrisma();
    const service = await buildService(prisma);

    await expect(service.createInvoice('acc-1', {}, ACTOR)).rejects.toThrow(
      /청구할 거래가 없습니다/,
    );
  });

  // 입금만 남았으면 받을 돈이 아니라 돌려줄 돈이다.
  it('합계가 0 이하면 만들지 않는다', async () => {
    const prisma = buildPrisma({
      arTransaction: {
        findMany: jest.fn().mockResolvedValue([{ id: 'tx-1', amount: new Prisma.Decimal(-1000) }]),
      },
    });
    const service = await buildService(prisma);

    await expect(service.createInvoice('acc-1', {}, ACTOR)).rejects.toThrow(/청구 합계가/);
  });

  it('번호를 이어서 매긴다', async () => {
    const prisma = buildPrisma({
      arTransaction: { findMany: jest.fn().mockResolvedValue(UNBILLED) },
      arInvoice: { findFirst: jest.fn().mockResolvedValue({ number: 'INV-2026-0007' }) },
    });
    const service = await buildService(prisma);

    await service.createInvoice('acc-1', {}, ACTOR);
    expect(prisma.tx.arInvoice.create.mock.calls[0][0].data.number).toBe('INV-2026-0008');
  });

  /*
   * 무효로 돌리면 묶여 있던 거래를 풀어 준다 — 그러지 않으면 잘못 발행한
   * 청구서 때문에 그 거래를 영영 청구하지 못한다.
   */
  it('무효로 돌리면 거래를 다시 풀어 준다', async () => {
    const prisma = buildPrisma({
      arInvoice: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ id: 'inv-1', propertyId: 'prop-1', status: ArInvoiceStatus.SENT }),
      },
    });
    const service = await buildService(prisma);

    await service.updateInvoiceStatus('inv-1', { status: ArInvoiceStatus.VOID }, ACTOR);

    expect(prisma.tx.arTransaction.updateMany).toHaveBeenCalledWith({
      where: { invoiceId: 'inv-1' },
      data: { invoiceId: null },
    });
  });

  it('보냄으로 바꾸면 시각을 남긴다', async () => {
    const prisma = buildPrisma({
      arInvoice: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ id: 'inv-1', propertyId: 'prop-1', status: ArInvoiceStatus.DRAFT }),
      },
    });
    const service = await buildService(prisma);

    await service.updateInvoiceStatus('inv-1', { status: ArInvoiceStatus.SENT }, ACTOR);

    expect(prisma.tx.arInvoice.update.mock.calls[0][0].data.sentAt).toBeInstanceOf(Date);
    expect(prisma.tx.arTransaction.updateMany).not.toHaveBeenCalled();
  });

  it('무효 처리된 청구서는 되돌리지 않는다', async () => {
    const prisma = buildPrisma({
      arInvoice: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ id: 'inv-1', propertyId: 'prop-1', status: ArInvoiceStatus.VOID }),
      },
    });
    const service = await buildService(prisma);

    await expect(
      service.updateInvoiceStatus('inv-1', { status: ArInvoiceStatus.SENT }, ACTOR),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('없는 청구서는 404 를 낸다', async () => {
    const prisma = buildPrisma();
    const service = await buildService(prisma);

    await expect(
      service.updateInvoiceStatus('nope', { status: ArInvoiceStatus.SENT }, ACTOR),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
