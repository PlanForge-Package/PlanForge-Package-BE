import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { FolioStatus, PostingType, UserRole } from '@prisma/client';
import { CoreClient } from '../core/core.client';
import type { CoreFolio } from '../core/core.types';
import { PrismaService } from '../prisma/prisma.service';
import { FoliosService } from './folios.service';

// Mirroring is covered by folio-mirror.spec.ts. Here only delegation and guards.
jest.mock('./folio-mirror', () => ({
  ...jest.requireActual('./folio-mirror'),
  mirrorFolios: jest.fn().mockResolvedValue(undefined),
}));

const ACTOR = {
  id: 'actor-1',
  sub: 'actor-1',
  email: 'actor@planforge.local',
  name: '검사자',
  role: UserRole.MANAGER,
  propertyId: null,
} as const;

const RESERVATION = {
  id: 'res-1',
  propertyId: 'prop-1',
  currency: 'KRW',
  operaReservationId: 'RSV-1001',
  property: { operaHotelId: 'SAND01' },
};

function coreFolio(window = 1): CoreFolio {
  return {
    folioId: `FOL-80${window}`,
    reservationId: 'RSV-1001',
    window,
    status: 'Open',
    balance: 0,
    currencyCode: 'KRW',
    postings: [],
  };
}

function buildPrisma(overrides: Record<string, unknown> = {}) {
  const tx = { folio: {}, posting: {} };
  return {
    tx,
    reservation: {
      findUnique: jest.fn().mockResolvedValue(RESERVATION),
      ...((overrides.reservation as object) ?? {}),
    },
    folio: {
      findUnique: jest.fn().mockResolvedValue({ id: 'folio-1', window: 1 }),
      findMany: jest.fn().mockResolvedValue([]),
      ...((overrides.folio as object) ?? {}),
    },
    posting: {
      findUnique: jest.fn().mockResolvedValue(null),
      ...((overrides.posting as object) ?? {}),
    },
    folioRouting: {
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn().mockResolvedValue(null),
      upsert: jest.fn().mockImplementation(({ create }) => ({ id: 'route-1', ...create })),
      delete: jest.fn(),
      ...((overrides.folioRouting as object) ?? {}),
    },
    syncLog: {
      create: jest.fn().mockResolvedValue({ id: 'log-1' }),
      update: jest.fn().mockResolvedValue({}),
    },
    $transaction: jest.fn((cb: (client: unknown) => unknown) => cb(tx)),
  };
}

function buildCore(overrides: Record<string, unknown> = {}) {
  return {
    openFolio: jest.fn().mockResolvedValue(coreFolio(2)),
    createPosting: jest.fn().mockResolvedValue(coreFolio(1)),
    transferPosting: jest
      .fn()
      .mockResolvedValue({ reservationId: 'RSV-1001', folios: [coreFolio(1), coreFolio(2)] }),
    ...overrides,
  };
}

async function buildService(
  prisma: ReturnType<typeof buildPrisma>,
  core: ReturnType<typeof buildCore> = buildCore(),
) {
  const moduleRef = await Test.createTestingModule({
    providers: [
      FoliosService,
      { provide: PrismaService, useValue: prisma },
      { provide: CoreClient, useValue: core },
    ],
  }).compile();
  return moduleRef.get(FoliosService);
}

const CHARGE = {
  type: PostingType.CHARGE,
  transactionCode: '1000',
  description: '객실료',
  amount: 240000,
};

describe('FoliosService — 위임', () => {
  it('창구 개설을 OPERA 에 맡긴다', async () => {
    const prisma = buildPrisma();
    const core = buildCore();
    const service = await buildService(prisma, core);

    await service.openWindow('res-1', { window: 2 }, ACTOR);

    expect(core.openFolio).toHaveBeenCalledWith('RSV-1001', {
      hotelId: 'SAND01',
      window: 2,
    });
  });

  it('거래 등록을 OPERA 에 맡기고 종류를 저쪽 표기로 보낸다', async () => {
    const prisma = buildPrisma();
    const core = buildCore();
    const service = await buildService(prisma, core);

    await service.addPosting('res-1', 1, CHARGE, ACTOR);

    expect(core.createPosting).toHaveBeenCalledWith(
      'RSV-1001',
      1,
      expect.objectContaining({ type: 'Charge', amount: 240000, hotelId: 'SAND01' }),
    );
  });

  // Letting the caller choose the sign invites sending a payment positive and growing the balance.
  it('조정의 차감 방향만 따로 넘긴다', async () => {
    const prisma = buildPrisma();
    const core = buildCore();
    const service = await buildService(prisma, core);

    await service.addPosting(
      'res-1',
      1,
      { ...CHARGE, type: PostingType.ADJUSTMENT, negative: true },
      ACTOR,
    );

    expect(core.createPosting.mock.calls[0][2]).toMatchObject({
      type: 'Adjustment',
      negative: true,
    });
  });

  it('OPERA 가 거절하면 그대로 올린다', async () => {
    const prisma = buildPrisma();
    const core = buildCore({
      createPosting: jest.fn().mockRejectedValue(new BadRequestException('이미 마감')),
    });
    const service = await buildService(prisma, core);

    await expect(service.addPosting('res-1', 1, CHARGE, ACTOR)).rejects.toThrow(/이미 마감/);
  });

  it('실패를 SyncLog 에 남긴다', async () => {
    const prisma = buildPrisma();
    const core = buildCore({
      createPosting: jest.fn().mockRejectedValue(new Error('연결 실패')),
    });
    const service = await buildService(prisma, core);

    await expect(service.addPosting('res-1', 1, CHARGE, ACTOR)).rejects.toThrow();
    expect(prisma.syncLog.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'FAILED' }) }),
    );
  });

  it('OPERA 에 연결되지 않은 예약은 막는다', async () => {
    const prisma = buildPrisma({
      reservation: {
        findUnique: jest.fn().mockResolvedValue({ ...RESERVATION, operaReservationId: null }),
      },
    });
    const core = buildCore();
    const service = await buildService(prisma, core);

    await expect(service.addPosting('res-1', 1, CHARGE, ACTOR)).rejects.toThrow(/동기화/);
    expect(core.createPosting).not.toHaveBeenCalled();
  });

  it('없는 예약이면 404 를 낸다', async () => {
    const prisma = buildPrisma({
      reservation: { findUnique: jest.fn().mockResolvedValue(null) },
    });
    const service = await buildService(prisma);

    await expect(service.addPosting('nope', 1, CHARGE, ACTOR)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

describe('FoliosService — 이관', () => {
  function posting(overrides: Record<string, unknown> = {}) {
    return {
      id: 'post-1',
      operaPostingId: 'PST-801',
      paymentId: null,
      folio: { reservationId: 'res-1', window: 1, status: FolioStatus.OPEN },
      ...overrides,
    };
  }

  it('OPERA 에 맡기고 두 창구를 함께 갱신한다', async () => {
    const prisma = buildPrisma({ posting: { findUnique: jest.fn().mockResolvedValue(posting()) } });
    const core = buildCore();
    const service = await buildService(prisma, core);

    await service.transferPosting('res-1', 'post-1', { toWindow: 2 }, ACTOR);

    expect(core.transferPosting).toHaveBeenCalledWith('RSV-1001', 'PST-801', {
      hotelId: 'SAND01',
      toWindow: 2,
    });
  });

  /*
   * The Payment points at a folio, so moving only the posting leaves a refund unable
   * to tell which folio to reverse. OPERA does not know this relation, so it is blocked here.
   */
  it('결제로 생긴 거래는 옮기지 않는다', async () => {
    const prisma = buildPrisma({
      posting: { findUnique: jest.fn().mockResolvedValue(posting({ paymentId: 'pay-1' })) },
    });
    const core = buildCore();
    const service = await buildService(prisma, core);

    await expect(
      service.transferPosting('res-1', 'post-1', { toWindow: 2 }, ACTOR),
    ).rejects.toThrow(/결제로 생긴 거래/);
    expect(core.transferPosting).not.toHaveBeenCalled();
  });

  it('OPERA 와 연결되지 않은 거래는 옮기지 않는다', async () => {
    const prisma = buildPrisma({
      posting: { findUnique: jest.fn().mockResolvedValue(posting({ operaPostingId: null })) },
    });
    const core = buildCore();
    const service = await buildService(prisma, core);

    await expect(
      service.transferPosting('res-1', 'post-1', { toWindow: 2 }, ACTOR),
    ).rejects.toThrow(/동기화/);
  });

  it('다른 예약의 거래는 옮기지 않는다', async () => {
    const prisma = buildPrisma({
      posting: {
        findUnique: jest
          .fn()
          .mockResolvedValue(posting({ folio: { reservationId: 'res-9', window: 1 } })),
      },
    });
    const service = await buildService(prisma);

    await expect(
      service.transferPosting('res-1', 'post-1', { toWindow: 2 }, ACTOR),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('FoliosService — 라우팅 지시', () => {
  it('거래 코드별 목적지를 저장한다', async () => {
    const prisma = buildPrisma();
    const service = await buildService(prisma);

    await service.setRouting('res-1', { transactionCode: '1000', targetWindow: 2 }, ACTOR);

    expect(prisma.folioRouting.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          reservationId_transactionCode: { reservationId: 'res-1', transactionCode: '1000' },
        },
      }),
    );
  });

  // Sending to a missing window fails on every charge.
  it('열려 있지 않은 창구로는 걸지 않는다', async () => {
    const prisma = buildPrisma({ folio: { findUnique: jest.fn().mockResolvedValue(null) } });
    const service = await buildService(prisma);

    await expect(
      service.setRouting('res-1', { transactionCode: '1000', targetWindow: 5 }, ACTOR),
    ).rejects.toThrow(/열려 있지 않습니다/);
  });

  it('없는 지시는 해제하지 못한다', async () => {
    const prisma = buildPrisma();
    const service = await buildService(prisma);

    await expect(service.removeRouting('res-1', '9999', ACTOR)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('해제하면 지시를 지운다', async () => {
    const prisma = buildPrisma({
      folioRouting: { findUnique: jest.fn().mockResolvedValue({ id: 'route-1' }) },
    });
    const service = await buildService(prisma);

    await service.removeRouting('res-1', '1000', ACTOR);
    expect(prisma.folioRouting.delete).toHaveBeenCalledWith({ where: { id: 'route-1' } });
  });
});
