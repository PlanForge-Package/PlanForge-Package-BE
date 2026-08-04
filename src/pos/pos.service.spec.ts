import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { FolioStatus, Prisma, type PosOutlet } from '@prisma/client';
import { CoreClient } from '../core/core.client';
import type { CoreFolio } from '../core/core.types';
import { PrismaService } from '../prisma/prisma.service';
import { PosService } from './pos.service';

// Mirroring is covered separately by folio-mirror.spec.ts.
jest.mock('../folios/folio-mirror', () => ({
  ...jest.requireActual('../folios/folio-mirror'),
  mirrorFolios: jest.fn().mockResolvedValue(undefined),
}));

const OUTLET = {
  id: 'out-1',
  propertyId: 'prop-1',
  code: 'RESTAURANT',
  name: '1층 레스토랑',
  transactionCode: 'FNB',
} as PosOutlet;

const CHARGE = {
  roomNumber: '1203',
  amount: 45000,
  description: '조식 2인',
  reference: 'CHK-1001',
};

const RESERVATION = {
  id: 'res-1',
  currency: 'KRW',
  operaReservationId: 'RSV-1001',
  assignedRoomNumber: '1203',
  property: { operaHotelId: 'SAND01' },
};

function coreFolio(balance = 45000): CoreFolio {
  return {
    folioId: 'FOL-801',
    reservationId: 'RSV-1001',
    window: 1,
    status: 'Open',
    balance,
    currencyCode: 'KRW',
    postings: [],
  };
}

/** The local posting mirroring would have created. */
function mirrored(overrides: Record<string, unknown> = {}) {
  return {
    id: 'pst-1',
    folioId: 'fol-1',
    outletId: null,
    reference: CHARGE.reference,
    amount: new Prisma.Decimal(45000),
    postedAt: new Date('2026-08-04T10:00:00Z'),
    ...overrides,
  };
}

function buildPrisma(overrides: Record<string, unknown> = {}) {
  const tx = {
    posting: {
      findFirst: jest.fn().mockResolvedValue(mirrored()),
      update: jest.fn(),
      ...((overrides.txPosting as object) ?? {}),
    },
  };

  return {
    tx,
    reservation: {
      findFirst: jest.fn().mockResolvedValue(RESERVATION),
      findMany: jest.fn().mockResolvedValue([]),
      ...((overrides.reservation as object) ?? {}),
    },
    posting: {
      findUnique: jest.fn().mockResolvedValue(null),
      ...((overrides.posting as object) ?? {}),
    },
    folioRouting: {
      findUnique: jest.fn().mockResolvedValue(null),
      ...((overrides.folioRouting as object) ?? {}),
    },
    $transaction: jest.fn((fn: (t: typeof tx) => unknown) => fn(tx)),
  };
}

function buildCore(overrides: Record<string, unknown> = {}) {
  return {
    createPosting: jest.fn().mockResolvedValue(coreFolio()),
    voidPosting: jest.fn().mockResolvedValue(coreFolio(0)),
    ...overrides,
  };
}

async function buildService(
  prisma: ReturnType<typeof buildPrisma>,
  core: ReturnType<typeof buildCore> = buildCore(),
) {
  const moduleRef = await Test.createTestingModule({
    providers: [
      PosService,
      { provide: PrismaService, useValue: prisma },
      { provide: CoreClient, useValue: core },
    ],
  }).compile();
  return moduleRef.get(PosService);
}

describe('PosService — 룸차지', () => {
  it('OPERA 폴리오에 요금을 달고 잔액을 그대로 받는다', async () => {
    const prisma = buildPrisma();
    const core = buildCore();
    const service = await buildService(prisma, core);

    const result = await service.postCharge(OUTLET, CHARGE);

    expect(core.createPosting).toHaveBeenCalledWith(
      'RSV-1001',
      1,
      expect.objectContaining({
        type: 'Charge',
        transactionCode: 'FNB',
        // The bill alone has to show which outlet raised the charge.
        description: '[1층 레스토랑] 조식 2인',
        reference: 'CHK-1001',
      }),
    );
    expect(result.duplicate).toBe(false);
    expect(result.folioBalance).toBe('45000');
  });

  // OPERA does not know which outlet posted it. That stays only in our copy.
  it('사본에 아웃렛을 붙인다', async () => {
    const prisma = buildPrisma();
    const service = await buildService(prisma);

    await service.postCharge(OUTLET, CHARGE);

    expect(prisma.tx.posting.update).toHaveBeenCalledWith({
      where: { id: 'pst-1' },
      data: { outletId: 'out-1' },
    });
  });

  /*
   * A POS resending after a network drop is common. There is no reason to spend an
   * external call on a retry we already recognise.
   */
  it('같은 전표를 다시 보내면 OPERA 를 부르지 않는다', async () => {
    const prisma = buildPrisma({
      posting: {
        findUnique: jest.fn().mockResolvedValue({
          ...mirrored(),
          folio: { reservationId: 'res-1', window: 1, balance: new Prisma.Decimal(45000) },
        }),
      },
    });
    const core = buildCore();
    const service = await buildService(prisma, core);

    const result = await service.postCharge(OUTLET, CHARGE);

    expect(result.duplicate).toBe(true);
    expect(core.createPosting).not.toHaveBeenCalled();
  });

  // Charging an empty room creates a bill nobody will pay.
  it('재실 예약이 없는 객실은 거절한다', async () => {
    const prisma = buildPrisma({ reservation: { findFirst: jest.fn().mockResolvedValue(null) } });
    const core = buildCore();
    const service = await buildService(prisma, core);

    await expect(service.postCharge(OUTLET, CHARGE)).rejects.toBeInstanceOf(NotFoundException);
    expect(core.createPosting).not.toHaveBeenCalled();
  });

  it('OPERA 와 연결되지 않은 예약은 거절한다', async () => {
    const prisma = buildPrisma({
      reservation: {
        findFirst: jest.fn().mockResolvedValue({ ...RESERVATION, operaReservationId: null }),
      },
    });
    const core = buildCore();
    const service = await buildService(prisma, core);

    await expect(service.postCharge(OUTLET, CHARGE)).rejects.toThrow(/연결되지 않은/);
    expect(core.createPosting).not.toHaveBeenCalled();
  });

  // Shop staff do not know what a folio window is. They need the next step too.
  it('마감 거절을 단말이 읽을 수 있는 말로 바꾼다', async () => {
    const prisma = buildPrisma();
    const core = buildCore({
      createPosting: jest
        .fn()
        .mockRejectedValue(new BadRequestException('윈도 1 은 이미 마감되었습니다.')),
    });
    const service = await buildService(prisma, core);

    await expect(service.postCharge(OUTLET, CHARGE)).rejects.toThrow(/프런트에 문의/);
  });

  // If one outlet key could charge another hotel's rooms, it would open the whole chain.
  it('자기 호텔 안에서만 객실을 찾는다', async () => {
    const prisma = buildPrisma();
    const service = await buildService(prisma);

    await service.postCharge(OUTLET, CHARGE);
    expect(prisma.reservation.findFirst.mock.calls[0][0].where).toEqual(
      expect.objectContaining({ propertyId: 'prop-1', status: 'IN_HOUSE' }),
    );
  });

  // Accepted by OPERA but absent from our copy leaves a charge we can neither void nor reconcile.
  it('사본에서 거래를 찾지 못하면 조용히 넘기지 않는다', async () => {
    const prisma = buildPrisma({ txPosting: { findFirst: jest.fn().mockResolvedValue(null) } });
    const service = await buildService(prisma);

    await expect(service.postCharge(OUTLET, CHARGE)).rejects.toThrow(/확인하지 못했습니다/);
  });
});

describe('PosService — 라우팅', () => {
  /*
   * A POS terminal does not know this reservation's billing split. Where the company
   * pays the room and the guest pays extras, trusting its window misplaces the charge.
   */
  it('지시가 있으면 그 창구로 단다', async () => {
    const prisma = buildPrisma({
      folioRouting: { findUnique: jest.fn().mockResolvedValue({ targetWindow: 2 }) },
    });
    const core = buildCore();
    const service = await buildService(prisma, core);

    const result = await service.postCharge(OUTLET, CHARGE);

    expect(core.createPosting.mock.calls[0][1]).toBe(2);
    expect(result.window).toBe(2);
  });

  it('지시가 없으면 1번 창구로 단다', async () => {
    const prisma = buildPrisma();
    const core = buildCore();
    const service = await buildService(prisma, core);

    const result = await service.postCharge(OUTLET, CHARGE);

    expect(core.createPosting.mock.calls[0][1]).toBe(1);
    expect(result.window).toBe(1);
  });

  // A window the terminal did specify is respected.
  it('단말이 창구를 지정하면 지시를 보지 않는다', async () => {
    const prisma = buildPrisma();
    const core = buildCore();
    const service = await buildService(prisma, core);

    const result = await service.postCharge(OUTLET, { ...CHARGE, window: 3 });

    expect(prisma.folioRouting.findUnique).not.toHaveBeenCalled();
    expect(result.window).toBe(3);
  });
});

describe('PosService — 취소', () => {
  function original(overrides: Record<string, unknown> = {}) {
    return {
      id: 'pst-1',
      folioId: 'fol-1',
      operaPostingId: 'PST-801',
      amount: new Prisma.Decimal(45000),
      voidedById: null,
      folio: {
        status: FolioStatus.OPEN,
        reservation: RESERVATION,
      },
      ...overrides,
    };
  }

  it('OPERA 에 취소를 맡기고 전표를 붙인다', async () => {
    const prisma = buildPrisma({
      posting: { findUnique: jest.fn().mockResolvedValue(original()) },
    });
    const core = buildCore();
    const service = await buildService(prisma, core);

    const result = await service.voidCharge(OUTLET, { reference: 'CHK-1001' });

    expect(core.voidPosting).toHaveBeenCalledWith(
      'RSV-1001',
      'PST-801',
      expect.objectContaining({ reference: 'CHK-1001-VOID' }),
    );
    expect(result.balance).toBe('0');
  });

  /*
   * voidedById points at the adjustment that voided this posting. The reverse
   * relation gives "the original this adjustment voided" and is always empty.
   */
  it('이미 취소된 전표는 다시 취소할 수 없다', async () => {
    const prisma = buildPrisma({
      posting: { findUnique: jest.fn().mockResolvedValue(original({ voidedById: 'pst-void' })) },
    });
    const core = buildCore();
    const service = await buildService(prisma, core);

    await expect(service.voidCharge(OUTLET, { reference: 'CHK-1001' })).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(core.voidPosting).not.toHaveBeenCalled();
  });

  it('없는 전표는 거절한다', async () => {
    const prisma = buildPrisma();
    const service = await buildService(prisma);

    await expect(service.voidCharge(OUTLET, { reference: 'NOPE' })).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('마감된 폴리오의 전표는 취소할 수 없다', async () => {
    const prisma = buildPrisma({
      posting: {
        findUnique: jest.fn().mockResolvedValue(
          original({
            folio: { status: FolioStatus.CLOSED, reservation: RESERVATION },
          }),
        ),
      },
    });
    const service = await buildService(prisma);

    await expect(service.voidCharge(OUTLET, { reference: 'CHK-1001' })).rejects.toThrow(/마감/);
  });

  it('OPERA 와 연결되지 않은 거래는 취소할 수 없다', async () => {
    const prisma = buildPrisma({
      posting: { findUnique: jest.fn().mockResolvedValue(original({ operaPostingId: null })) },
    });
    const core = buildCore();
    const service = await buildService(prisma, core);

    await expect(service.voidCharge(OUTLET, { reference: 'CHK-1001' })).rejects.toThrow(
      /연결되지 않은/,
    );
    expect(core.voidPosting).not.toHaveBeenCalled();
  });
});

describe('PosService — 요금 달 수 있는 객실', () => {
  // A full guest list on a shop terminal is a leak in itself.
  it('객실 번호와 성만 준다', async () => {
    const prisma = buildPrisma({
      reservation: {
        findFirst: jest.fn(),
        findMany: jest
          .fn()
          .mockResolvedValue([{ assignedRoomNumber: '1203', profile: { lastName: '김' } }]),
      },
    });
    const service = await buildService(prisma);

    const result = await service.chargeableRooms(OUTLET);

    expect(result.items).toEqual([{ roomNumber: '1203', guestLastName: '김' }]);
  });
});
