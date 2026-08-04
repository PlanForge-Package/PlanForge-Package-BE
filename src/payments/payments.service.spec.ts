import { BadRequestException, ConflictException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { FolioStatus, PaymentMethod, PaymentStatus, Prisma, UserRole } from '@prisma/client';
import type { AuthUser } from '../auth/auth.constants';
import { PrismaService } from '../prisma/prisma.service';
import { CoreClient } from '../core/core.client';
import { PAYMENT_DRIVER, PaymentError } from './payment.driver';
import { PaymentsService } from './payments.service';

// 미러링은 folio-mirror.spec.ts 가 따로 본다. 여기서는 위임과 가드만 본다.
jest.mock('../folios/folio-mirror', () => ({
  ...jest.requireActual('../folios/folio-mirror'),
  mirrorFolios: jest.fn().mockResolvedValue(undefined),
}));

const ACTOR: AuthUser = {
  id: 'u1',
  sub: 'u1',
  email: 'a@b.c',
  name: '프런트',
  role: UserRole.FRONT_DESK,
  propertyId: null,
};

const CARD = {
  method: PaymentMethod.CARD,
  amount: 340000,
  paymentToken: 'tok_ok_123',
  idempotencyKey: 'PAY-1',
};

function payment(overrides: Record<string, unknown> = {}) {
  return {
    id: 'pay-1',
    folioId: 'fol-1',
    method: PaymentMethod.CARD,
    status: PaymentStatus.AUTHORIZED,
    amount: new Prisma.Decimal(340000),
    refundedAmount: new Prisma.Decimal(0),
    currency: 'KRW',
    vendorTxnId: 'MOCKTXN-AAA',
    maskedCard: '**** **** **** 1234',
    folio: { reservation: { propertyId: 'prop-1' } },
    ...overrides,
  };
}

function buildPrisma(overrides: Record<string, unknown> = {}) {
  const tx = {
    payment: {
      create: jest.fn().mockImplementation(({ data }) => ({ id: 'pay-new', ...data })),
      update: jest.fn().mockImplementation(({ data }) => ({ ...payment(), ...data })),
    },
    posting: {
      findFirst: jest.fn().mockResolvedValue({ id: 'pst-1', paymentId: null }),
      update: jest.fn(),
    },
  };

  return {
    tx,
    reservation: {
      findUnique: jest.fn().mockResolvedValue({
        id: 'res-1',
        propertyId: 'prop-1',
        currency: 'KRW',
        operaReservationId: 'RSV-1001',
        property: { operaHotelId: 'SAND01' },
      }),
    },
    folio: {
      findUnique: jest.fn().mockResolvedValue({
        id: 'fol-1',
        status: FolioStatus.OPEN,
        currency: 'KRW',
        reservationId: 'res-1',
        window: 1,
      }),
    },
    payment: {
      findUnique: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockImplementation(({ data }) => ({ id: 'pay-new', ...data })),
      update: jest.fn().mockImplementation(({ data }) => ({ ...payment(), ...data })),
      ...(overrides.payment ?? {}),
    },
    $transaction: jest.fn((fn: (t: typeof tx) => unknown) => fn(tx)),
  };
}

function buildCore(overrides: Record<string, unknown> = {}) {
  return {
    createPosting: jest.fn().mockResolvedValue({
      folioId: 'FOL-801',
      reservationId: 'RSV-1001',
      window: 1,
      status: 'Open',
      balance: 0,
      currencyCode: 'KRW',
      postings: [],
    }),
    ...overrides,
  };
}

function buildDriver() {
  return {
    mode: 'mock' as const,
    authorize: jest.fn().mockResolvedValue({
      vendorTxnId: 'MOCKTXN-NEW',
      approvalNumber: 'AB12',
      maskedCard: '**** **** **** 4321',
      cardBrand: 'MOCKCARD',
    }),
    capture: jest.fn().mockResolvedValue(undefined),
    void: jest.fn().mockResolvedValue(undefined),
    refund: jest.fn().mockResolvedValue(undefined),
  };
}

async function buildService(
  prisma: ReturnType<typeof buildPrisma>,
  driver: ReturnType<typeof buildDriver> = buildDriver(),
  core: ReturnType<typeof buildCore> = buildCore(),
) {
  const moduleRef = await Test.createTestingModule({
    providers: [
      PaymentsService,
      { provide: PrismaService, useValue: prisma },
      { provide: CoreClient, useValue: core },
      { provide: PAYMENT_DRIVER, useValue: driver },
    ],
  }).compile();
  return moduleRef.get(PaymentsService);
}

describe('PaymentsService — 승인', () => {
  it('카드는 승인만 하고 폴리오는 건드리지 않는다', async () => {
    const prisma = buildPrisma();
    const driver = buildDriver();
    const core = buildCore();
    const service = await buildService(prisma, driver, core);

    const result = await service.authorize('res-1', 1, CARD, ACTOR);

    expect(driver.authorize).toHaveBeenCalledWith(
      expect.objectContaining({ paymentToken: 'tok_ok_123', amount: '340000.00' }),
    );
    expect(result.status).toBe(PaymentStatus.AUTHORIZED);
    // 승인만으로 잔액을 줄이면 매입에 실패했을 때 받지도 않은 돈이 받은 것으로 남는다.
    expect(core.createPosting).not.toHaveBeenCalled();
  });

  // 재전송되면 같은 카드로 두 번 긁힌다. 손님 돈이 두 번 나가는 일은 되돌리기 어렵다.
  it('같은 멱등키는 새로 긁지 않고 기존 건을 돌려준다', async () => {
    const prisma = buildPrisma({ payment: { findUnique: jest.fn().mockResolvedValue(payment()) } });
    const driver = buildDriver();
    const service = await buildService(prisma, driver);

    const result = await service.authorize('res-1', 1, CARD, ACTOR);

    expect(result.id).toBe('pay-1');
    expect(driver.authorize).not.toHaveBeenCalled();
  });

  /*
   * 현금은 사람이 받아 확인한 돈이다. 두 단계로 나누면 프런트가 매입을 잊고,
   * 받은 돈이 폴리오에 없는 상태가 된다.
   */
  it('현금은 곧바로 매입 상태로 폴리오에 올린다', async () => {
    const prisma = buildPrisma();
    const driver = buildDriver();
    const core = buildCore();
    const service = await buildService(prisma, driver, core);

    const result = await service.authorize(
      'res-1',
      1,
      { ...CARD, method: PaymentMethod.CASH, paymentToken: undefined },
      ACTOR,
    );

    expect(driver.authorize).not.toHaveBeenCalled();
    expect(result.status).toBe(PaymentStatus.CAPTURED);
    // 부호는 OPERA 가 종류로 정한다. 우리는 양수로 보낸다.
    expect(core.createPosting.mock.calls[0][2]).toMatchObject({ type: 'Payment', amount: 340000 });
  });

  it('카드인데 토큰이 없으면 거절한다', async () => {
    const prisma = buildPrisma();
    const service = await buildService(prisma);

    await expect(
      service.authorize('res-1', 1, { ...CARD, paymentToken: undefined }, ACTOR),
    ).rejects.toThrow(/결제 토큰/);
  });

  // 같은 카드로 반복 시도했는지 나중에 확인해야 한다.
  it('거절은 실패 이력을 남긴다', async () => {
    const prisma = buildPrisma();
    const driver = buildDriver();
    driver.authorize.mockRejectedValue(new PaymentError('한도 초과', true));
    const service = await buildService(prisma, driver);

    await expect(service.authorize('res-1', 1, CARD, ACTOR)).rejects.toThrow(/한도 초과/);
    expect(prisma.payment.create.mock.calls[0][0].data.status).toBe(PaymentStatus.FAILED);
  });

  /*
   * 멱등키를 소진해 버리면 같은 키로 다시 시도할 수 없고, 실제로 승인이 났는지
   * 확인할 방법도 막힌다.
   */
  it('결과 불명은 이력을 남기지 않고 확인을 요구한다', async () => {
    const prisma = buildPrisma();
    const driver = buildDriver();
    driver.authorize.mockRejectedValue(new PaymentError('timeout', false));
    const service = await buildService(prisma, driver);

    await expect(service.authorize('res-1', 1, CARD, ACTOR)).rejects.toThrow(/PG 관리자에서 확인/);
    expect(prisma.payment.create).not.toHaveBeenCalled();
  });

  it('마감된 폴리오에는 붙일 수 없다', async () => {
    const prisma = buildPrisma();
    prisma.folio.findUnique.mockResolvedValue({
      id: 'fol-1',
      status: FolioStatus.CLOSED,
      currency: 'KRW',
    });
    const service = await buildService(prisma);

    await expect(service.authorize('res-1', 1, CARD, ACTOR)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('다른 호텔 예약은 막는다', async () => {
    const prisma = buildPrisma();
    const service = await buildService(prisma);
    const scoped: AuthUser = { ...ACTOR, propertyId: 'prop-2' };

    await expect(service.authorize('res-1', 1, CARD, scoped)).rejects.toThrow(/접근할 수 없습니다/);
  });
});

describe('PaymentsService — 매입', () => {
  it('매입하면 폴리오에 결제가 올라간다', async () => {
    const prisma = buildPrisma({ payment: { findUnique: jest.fn().mockResolvedValue(payment()) } });
    const driver = buildDriver();
    const core = buildCore();
    const service = await buildService(prisma, driver, core);

    await service.capture('pay-1', {}, ACTOR);

    expect(driver.capture).toHaveBeenCalledWith('MOCKTXN-AAA', '340000.00');
    expect(core.createPosting).toHaveBeenCalledWith(
      'RSV-1001',
      1,
      expect.objectContaining({ type: 'Payment', amount: 340000 }),
    );
  });

  it('부분 매입이 된다', async () => {
    const prisma = buildPrisma({ payment: { findUnique: jest.fn().mockResolvedValue(payment()) } });
    const driver = buildDriver();
    const service = await buildService(prisma, driver);

    await service.capture('pay-1', { amount: 100000 }, ACTOR);
    expect(driver.capture).toHaveBeenCalledWith('MOCKTXN-AAA', '100000.00');
  });

  it('승인액을 넘는 매입은 거절한다', async () => {
    const prisma = buildPrisma({ payment: { findUnique: jest.fn().mockResolvedValue(payment()) } });
    const driver = buildDriver();
    const service = await buildService(prisma, driver);

    await expect(service.capture('pay-1', { amount: 500000 }, ACTOR)).rejects.toThrow(
      /승인액을 초과/,
    );
    expect(driver.capture).not.toHaveBeenCalled();
  });

  it('이미 매입된 건은 다시 매입할 수 없다', async () => {
    const prisma = buildPrisma({
      payment: {
        findUnique: jest.fn().mockResolvedValue(payment({ status: PaymentStatus.CAPTURED })),
      },
    });
    const service = await buildService(prisma);

    await expect(service.capture('pay-1', {}, ACTOR)).rejects.toBeInstanceOf(ConflictException);
  });

  // PG 에서 실패했는데 로컬만 매입으로 바꾸면 받지 않은 돈이 받은 것으로 남는다.
  it('PG 매입이 실패하면 로컬도 바꾸지 않는다', async () => {
    const prisma = buildPrisma({ payment: { findUnique: jest.fn().mockResolvedValue(payment()) } });
    const driver = buildDriver();
    driver.capture.mockRejectedValue(new PaymentError('망 장애', false));
    const service = await buildService(prisma, driver);

    await expect(service.capture('pay-1', {}, ACTOR)).rejects.toThrow(/매입하지 못했습니다/);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});

describe('PaymentsService — 승인 취소·환불', () => {
  it('승인 취소는 폴리오를 건드리지 않는다', async () => {
    const prisma = buildPrisma({ payment: { findUnique: jest.fn().mockResolvedValue(payment()) } });
    const driver = buildDriver();
    const core = buildCore();
    const service = await buildService(prisma, driver, core);

    const result = await service.void('pay-1', ACTOR);

    expect(driver.void).toHaveBeenCalledWith('MOCKTXN-AAA');
    expect(result.status).toBe(PaymentStatus.VOIDED);
    expect(core.createPosting).not.toHaveBeenCalled();
  });

  it('매입된 건은 승인 취소할 수 없다', async () => {
    const prisma = buildPrisma({
      payment: {
        findUnique: jest.fn().mockResolvedValue(payment({ status: PaymentStatus.CAPTURED })),
      },
    });
    const service = await buildService(prisma);

    await expect(service.void('pay-1', ACTOR)).rejects.toThrow(/환불로 처리/);
  });

  // 원래 결제를 지우면 명세서에서 결제가 통째로 사라져 무엇이 정정됐는지 알 수 없다.
  it('환불은 반대 부호 포스팅을 하나 더 단다', async () => {
    const prisma = buildPrisma({
      payment: {
        findUnique: jest.fn().mockResolvedValue(payment({ status: PaymentStatus.CAPTURED })),
      },
    });
    const driver = buildDriver();
    const core = buildCore();
    const service = await buildService(prisma, driver, core);

    await service.refund('pay-1', { amount: 50000, reason: '요금 조정' }, ACTOR);

    expect(driver.refund).toHaveBeenCalledWith('MOCKTXN-AAA', '50000.00');
    const posting = core.createPosting.mock.calls[0][2];
    // 결제가 음수로 올라가 있으므로 환불은 Adjustment 의 기본(양수) 방향이다.
    expect(posting).toMatchObject({ type: 'Adjustment', amount: 50000 });
    expect(posting.description).toContain('[환불]');
  });

  it('부분 환불을 누적해 남은 금액을 넘지 못하게 한다', async () => {
    const prisma = buildPrisma({
      payment: {
        findUnique: jest.fn().mockResolvedValue(
          payment({
            status: PaymentStatus.REFUNDED,
            refundedAmount: new Prisma.Decimal(300000),
          }),
        ),
      },
    });
    const driver = buildDriver();
    const service = await buildService(prisma, driver);

    await expect(service.refund('pay-1', { amount: 50000 }, ACTOR)).rejects.toThrow(
      /남은 금액: 40000/,
    );
    expect(driver.refund).not.toHaveBeenCalled();
  });

  /*
   * 현금은 PG 를 거치지 않았다. 부르면 PG 가 모르는 거래라며 거절해 현금 환불
   * 자체가 막힌다.
   */
  it('현금 환불은 PG 를 부르지 않는다', async () => {
    const prisma = buildPrisma({
      payment: {
        findUnique: jest.fn().mockResolvedValue(
          payment({
            method: PaymentMethod.CASH,
            status: PaymentStatus.CAPTURED,
            vendorTxnId: null,
          }),
        ),
      },
    });
    const driver = buildDriver();
    const core = buildCore();
    const service = await buildService(prisma, driver, core);

    await service.refund('pay-1', { amount: 10000 }, ACTOR);

    expect(driver.refund).not.toHaveBeenCalled();
    // 기록은 그대로 맞춘다. 실제 돈은 프런트가 손으로 내준다.
    expect(core.createPosting.mock.calls[0][2]).toMatchObject({ amount: 10000 });
  });

  it('PG 를 거치지 않은 결제는 승인 취소할 수 없다', async () => {
    const prisma = buildPrisma({
      payment: { findUnique: jest.fn().mockResolvedValue(payment({ vendorTxnId: null })) },
    });
    const driver = buildDriver();
    const service = await buildService(prisma, driver);

    await expect(service.void('pay-1', ACTOR)).rejects.toThrow(/PG 를 거치지 않은/);
    expect(driver.void).not.toHaveBeenCalled();
  });

  it('매입되지 않은 건은 환불할 수 없다', async () => {
    const prisma = buildPrisma({ payment: { findUnique: jest.fn().mockResolvedValue(payment()) } });
    const service = await buildService(prisma);

    await expect(service.refund('pay-1', { amount: 1000 }, ACTOR)).rejects.toBeInstanceOf(
      ConflictException,
    );
  });
});
