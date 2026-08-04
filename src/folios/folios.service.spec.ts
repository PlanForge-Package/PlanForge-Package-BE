import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { FolioStatus, PostingType, Prisma, UserRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { FoliosService } from './folios.service';

function buildTx() {
  return {
    reservation: { findUnique: jest.fn() },
    folio: { findUnique: jest.fn(), findMany: jest.fn(), create: jest.fn(), update: jest.fn() },
    posting: {
      create: jest.fn(),
      aggregate: jest.fn().mockResolvedValue({ _sum: { amount: new Prisma.Decimal(0) } }),
      findUnique: jest.fn(),
      findFirst: jest.fn().mockResolvedValue(null),
      update: jest.fn(),
    },
    folioRouting: { findUnique: jest.fn() },
  };
}

function buildPrisma(tx: ReturnType<typeof buildTx>, overrides: Record<string, unknown> = {}) {
  return {
    $transaction: jest.fn((cb: (client: unknown) => unknown) => cb(tx)),
    // assertReservationInScope 가 트랜잭션 밖에서 예약의 호텔을 먼저 확인한다.
    reservation: { findUnique: jest.fn().mockResolvedValue({ propertyId: 'prop-1' }) },
    folio: { findUnique: jest.fn() },
    folioRouting: {
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn().mockResolvedValue(null),
      upsert: jest.fn().mockImplementation(({ create }) => ({ id: 'route-1', ...create })),
      delete: jest.fn(),
    },
    ...overrides,
  };
}

async function buildService(
  tx: ReturnType<typeof buildTx>,
  prisma: ReturnType<typeof buildPrisma> = buildPrisma(tx),
) {
  const moduleRef = await Test.createTestingModule({
    providers: [FoliosService, { provide: PrismaService, useValue: prisma }],
  }).compile();
  return moduleRef.get(FoliosService);
}

/** 소속이 없는 계정. 호텔 범위 검사는 property-scope.spec.ts 가 따로 다룬다. */
const ACTOR = {
  id: 'actor-1',
  sub: 'actor-1',
  email: 'actor@planforge.local',
  name: '검사자',
  role: UserRole.MANAGER,
  propertyId: null,
} as const;

const OPEN_FOLIO = {
  id: 'folio-1',
  reservationId: 'res-1',
  window: 1,
  status: FolioStatus.OPEN,
  currency: 'KRW',
};

/** addPosting 이 저장한 amount 를 꺼낸다. */
function savedAmount(tx: ReturnType<typeof buildTx>): Prisma.Decimal {
  return tx.posting.create.mock.calls[0][0].data.amount;
}

describe('FoliosService', () => {
  describe('addPosting — 금액 부호', () => {
    it.each([
      [PostingType.CHARGE, '240000'],
      [PostingType.TAX, '24000'],
    ])('%s 는 양수로 저장한다', async (type, expected) => {
      const tx = buildTx();
      tx.folio.findUnique.mockResolvedValue(OPEN_FOLIO);
      tx.posting.aggregate.mockResolvedValue({ _sum: { amount: new Prisma.Decimal(expected) } });
      tx.folio.update.mockResolvedValue(OPEN_FOLIO);

      const service = await buildService(tx);
      await service.addPosting(
        'res-1',
        1,
        {
          type,
          transactionCode: '1000',
          description: 'x',
          amount: Number(expected),
        },
        ACTOR,
      );

      expect(savedAmount(tx).toString()).toBe(expected);
    });

    it('PAYMENT 는 양수로 받아 차감 방향으로 저장한다', async () => {
      const tx = buildTx();
      tx.folio.findUnique.mockResolvedValue(OPEN_FOLIO);
      tx.posting.aggregate.mockResolvedValue({ _sum: { amount: new Prisma.Decimal(0) } });
      tx.folio.update.mockResolvedValue(OPEN_FOLIO);

      const service = await buildService(tx);
      await service.addPosting(
        'res-1',
        1,
        {
          type: PostingType.PAYMENT,
          transactionCode: '5000',
          description: '카드 결제',
          amount: 340000,
        },
        ACTOR,
      );

      expect(savedAmount(tx).toString()).toBe('-340000');
    });

    it('ADJUSTMENT 는 negative 로 차감 방향을 고를 수 있다', async () => {
      const tx = buildTx();
      tx.folio.findUnique.mockResolvedValue(OPEN_FOLIO);
      tx.posting.aggregate.mockResolvedValue({ _sum: { amount: new Prisma.Decimal(0) } });
      tx.folio.update.mockResolvedValue(OPEN_FOLIO);

      const service = await buildService(tx);
      await service.addPosting(
        'res-1',
        1,
        {
          type: PostingType.ADJUSTMENT,
          transactionCode: '7000',
          description: '할인',
          amount: 10000,
          negative: true,
        },
        ACTOR,
      );

      expect(savedAmount(tx).toString()).toBe('-10000');
    });
  });

  describe('addPosting — 잔액', () => {
    it('증분이 아니라 거래 합계로 잔액을 다시 계산한다', async () => {
      const tx = buildTx();
      tx.folio.findUnique.mockResolvedValue({ ...OPEN_FOLIO, balance: new Prisma.Decimal(999) });
      tx.posting.aggregate.mockResolvedValue({ _sum: { amount: new Prisma.Decimal('264000') } });
      tx.folio.update.mockResolvedValue(OPEN_FOLIO);

      const service = await buildService(tx);
      await service.addPosting(
        'res-1',
        1,
        {
          type: PostingType.CHARGE,
          transactionCode: '1000',
          description: '객실료',
          amount: 240000,
        },
        ACTOR,
      );

      const updated = tx.folio.update.mock.calls[0][0];
      expect(updated.data.balance.toString()).toBe('264000');
    });

    it('거래가 하나도 없으면 잔액은 0 이다', async () => {
      const tx = buildTx();
      tx.folio.findUnique.mockResolvedValue(OPEN_FOLIO);
      tx.posting.aggregate.mockResolvedValue({ _sum: { amount: null } });
      tx.folio.update.mockResolvedValue(OPEN_FOLIO);

      const service = await buildService(tx);
      await service.addPosting(
        'res-1',
        1,
        {
          type: PostingType.CHARGE,
          transactionCode: '1000',
          description: 'x',
          amount: 1,
        },
        ACTOR,
      );

      expect(tx.folio.update.mock.calls[0][0].data.balance.toString()).toBe('0');
    });
  });

  describe('addPosting — 거절', () => {
    it('마감된 폴리오에는 등록하지 않는다', async () => {
      const tx = buildTx();
      tx.folio.findUnique.mockResolvedValue({ ...OPEN_FOLIO, status: FolioStatus.CLOSED });

      const service = await buildService(tx);
      await expect(
        service.addPosting(
          'res-1',
          1,
          {
            type: PostingType.CHARGE,
            transactionCode: '1000',
            description: 'x',
            amount: 1,
          },
          ACTOR,
        ),
      ).rejects.toThrow(/마감된 폴리오/);
      expect(tx.posting.create).not.toHaveBeenCalled();
    });

    it('없는 폴리오면 404 를 낸다', async () => {
      const tx = buildTx();
      tx.folio.findUnique.mockResolvedValue(null);

      const service = await buildService(tx);
      await expect(
        service.addPosting(
          'res-1',
          3,
          {
            type: PostingType.CHARGE,
            transactionCode: '1000',
            description: 'x',
            amount: 1,
          },
          ACTOR,
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('openWindow', () => {
    it('번호를 생략하면 비어 있는 다음 번호를 쓴다', async () => {
      const tx = buildTx();
      tx.reservation.findUnique.mockResolvedValue({ id: 'res-1', currency: 'KRW' });
      tx.folio.findMany.mockResolvedValue([{ window: 1 }, { window: 2 }]);
      tx.folio.create.mockResolvedValue({ window: 3 });

      const service = await buildService(tx);
      await service.openWindow('res-1', {}, ACTOR);

      expect(tx.folio.create).toHaveBeenCalledWith({
        data: { reservationId: 'res-1', window: 3, currency: 'KRW' },
      });
    });

    it('이미 열린 번호는 거절한다', async () => {
      const tx = buildTx();
      tx.reservation.findUnique.mockResolvedValue({ id: 'res-1', currency: 'KRW' });
      tx.folio.findMany.mockResolvedValue([{ window: 1 }]);

      const service = await buildService(tx);
      await expect(service.openWindow('res-1', { window: 1 }, ACTOR)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('윈도를 8개 넘게 열지 않는다', async () => {
      const tx = buildTx();
      tx.reservation.findUnique.mockResolvedValue({ id: 'res-1', currency: 'KRW' });
      tx.folio.findMany.mockResolvedValue(Array.from({ length: 8 }, (_, i) => ({ window: i + 1 })));

      const service = await buildService(tx);
      await expect(service.openWindow('res-1', {}, ACTOR)).rejects.toThrow(/8개까지만/);
    });

    it('없는 예약이면 404 를 낸다', async () => {
      const tx = buildTx();
      tx.reservation.findUnique.mockResolvedValue(null);

      const service = await buildService(tx);
      await expect(service.openWindow('nope', {}, ACTOR)).rejects.toBeInstanceOf(NotFoundException);
    });
  });
  describe('transferPosting', () => {
    const TARGET_FOLIO = {
      id: 'folio-2',
      reservationId: 'res-1',
      window: 2,
      status: FolioStatus.OPEN,
      currency: 'KRW',
    };

    function posting(overrides: Record<string, unknown> = {}) {
      return {
        id: 'post-1',
        folioId: 'folio-1',
        paymentId: null,
        voidedById: null,
        folio: OPEN_FOLIO,
        ...overrides,
      };
    }

    it('거래를 옮기고 양쪽 잔액을 다시 계산한다', async () => {
      const tx = buildTx();
      tx.posting.findUnique.mockResolvedValue(posting());
      tx.folio.findUnique.mockResolvedValue(TARGET_FOLIO);
      tx.folio.findMany.mockResolvedValue([]);

      const service = await buildService(tx);
      await service.transferPosting('res-1', 'post-1', { toWindow: 2 }, ACTOR);

      expect(tx.posting.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'post-1' },
          data: expect.objectContaining({ folioId: 'folio-2', transferredFromWindow: 1 }),
        }),
      );
      // 한쪽만 고치면 합계가 맞지 않는다.
      const updatedFolios = tx.folio.update.mock.calls.map((call) => call[0].where.id);
      expect(updatedFolios).toEqual(['folio-1', 'folio-2']);
    });

    it('누가 언제 옮겼는지 남긴다', async () => {
      const tx = buildTx();
      tx.posting.findUnique.mockResolvedValue(posting());
      tx.folio.findUnique.mockResolvedValue(TARGET_FOLIO);
      tx.folio.findMany.mockResolvedValue([]);

      const service = await buildService(tx);
      await service.transferPosting('res-1', 'post-1', { toWindow: 2 }, ACTOR);

      const data = tx.posting.update.mock.calls[0][0].data;
      expect(data.transferredById).toBe('actor-1');
      expect(data.transferredAt).toBeInstanceOf(Date);
    });

    it('같은 창구로는 옮기지 않는다', async () => {
      const tx = buildTx();
      tx.posting.findUnique.mockResolvedValue(posting());

      const service = await buildService(tx);
      await expect(
        service.transferPosting('res-1', 'post-1', { toWindow: 1 }, ACTOR),
      ).rejects.toThrow(/이미 윈도 1/);
    });

    // 원본과 조정이 갈라지면 양쪽 잔액이 모두 틀어진다.
    it('취소된 거래는 옮기지 않는다', async () => {
      const tx = buildTx();
      tx.posting.findUnique.mockResolvedValue(posting({ voidedById: 'post-9' }));

      const service = await buildService(tx);
      await expect(
        service.transferPosting('res-1', 'post-1', { toWindow: 2 }, ACTOR),
      ).rejects.toThrow(/취소된 거래/);
    });

    it('취소 조정도 옮기지 않는다', async () => {
      const tx = buildTx();
      tx.posting.findUnique.mockResolvedValue(posting());
      tx.posting.findFirst.mockResolvedValue({ id: 'post-0' });

      const service = await buildService(tx);
      await expect(
        service.transferPosting('res-1', 'post-1', { toWindow: 2 }, ACTOR),
      ).rejects.toThrow(/취소 조정/);
    });

    // 결제는 폴리오를 가리키고 있어, 포스팅만 옮기면 환불이 어느 쪽을 되돌릴지 모른다.
    it('결제로 생긴 거래는 옮기지 않는다', async () => {
      const tx = buildTx();
      tx.posting.findUnique.mockResolvedValue(posting({ paymentId: 'pay-1' }));

      const service = await buildService(tx);
      await expect(
        service.transferPosting('res-1', 'post-1', { toWindow: 2 }, ACTOR),
      ).rejects.toThrow(/결제로 생긴 거래/);
    });

    it('마감된 폴리오에서는 옮기지 않는다', async () => {
      const tx = buildTx();
      tx.posting.findUnique.mockResolvedValue(
        posting({ folio: { ...OPEN_FOLIO, status: FolioStatus.CLOSED } }),
      );

      const service = await buildService(tx);
      await expect(
        service.transferPosting('res-1', 'post-1', { toWindow: 2 }, ACTOR),
      ).rejects.toThrow(/마감된 폴리오/);
    });

    it('마감된 창구로는 옮기지 않는다', async () => {
      const tx = buildTx();
      tx.posting.findUnique.mockResolvedValue(posting());
      tx.folio.findUnique.mockResolvedValue({ ...TARGET_FOLIO, status: FolioStatus.CLOSED });

      const service = await buildService(tx);
      await expect(
        service.transferPosting('res-1', 'post-1', { toWindow: 2 }, ACTOR),
      ).rejects.toThrow(/이미 마감/);
    });

    it('열려 있지 않은 창구로는 옮기지 않는다', async () => {
      const tx = buildTx();
      tx.posting.findUnique.mockResolvedValue(posting());
      tx.folio.findUnique.mockResolvedValue(null);

      const service = await buildService(tx);
      await expect(
        service.transferPosting('res-1', 'post-1', { toWindow: 2 }, ACTOR),
      ).rejects.toThrow(/열려 있지 않습니다/);
    });

    it('다른 예약의 거래는 옮기지 않는다', async () => {
      const tx = buildTx();
      tx.posting.findUnique.mockResolvedValue(
        posting({ folio: { ...OPEN_FOLIO, reservationId: 'res-9' } }),
      );

      const service = await buildService(tx);
      await expect(
        service.transferPosting('res-1', 'post-1', { toWindow: 2 }, ACTOR),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('라우팅 지시', () => {
    it('거래 코드별 목적지를 저장한다', async () => {
      const tx = buildTx();
      const prisma = buildPrisma(tx);
      prisma.folio.findUnique.mockResolvedValue({ id: 'folio-2', window: 2 });

      const service = await buildService(tx, prisma);
      await service.setRouting('res-1', { transactionCode: '1000', targetWindow: 2 }, ACTOR);

      expect(prisma.folioRouting.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            reservationId_transactionCode: { reservationId: 'res-1', transactionCode: '1000' },
          },
        }),
      );
    });

    // 없는 창구로 보내면 요금이 붙을 때마다 실패한다.
    it('열려 있지 않은 창구로는 걸지 않는다', async () => {
      const tx = buildTx();
      const prisma = buildPrisma(tx);
      prisma.folio.findUnique.mockResolvedValue(null);

      const service = await buildService(tx, prisma);
      await expect(
        service.setRouting('res-1', { transactionCode: '1000', targetWindow: 5 }, ACTOR),
      ).rejects.toThrow(/열려 있지 않습니다/);
    });

    it('없는 지시는 해제하지 못한다', async () => {
      const tx = buildTx();
      const prisma = buildPrisma(tx);

      const service = await buildService(tx, prisma);
      await expect(service.removeRouting('res-1', '9999', ACTOR)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('해제하면 지시를 지운다', async () => {
      const tx = buildTx();
      const prisma = buildPrisma(tx);
      prisma.folioRouting.findUnique.mockResolvedValue({ id: 'route-1' });

      const service = await buildService(tx, prisma);
      await service.removeRouting('res-1', '1000', ACTOR);

      expect(prisma.folioRouting.delete).toHaveBeenCalledWith({ where: { id: 'route-1' } });
    });
  });
});
