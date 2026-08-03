import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { FolioStatus, PostingType, Prisma, UserRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { FoliosService } from './folios.service';

function buildTx() {
  return {
    reservation: { findUnique: jest.fn() },
    folio: { findUnique: jest.fn(), findMany: jest.fn(), create: jest.fn(), update: jest.fn() },
    posting: { create: jest.fn(), aggregate: jest.fn() },
  };
}

async function buildService(tx: ReturnType<typeof buildTx>) {
  const prisma = {
    $transaction: jest.fn((cb: (client: unknown) => unknown) => cb(tx)),
    // assertReservationInScope 가 트랜잭션 밖에서 예약의 호텔을 먼저 확인한다.
    reservation: { findUnique: jest.fn().mockResolvedValue({ propertyId: 'prop-1' }) },
  };
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
});
