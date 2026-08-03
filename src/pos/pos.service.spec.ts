import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { FolioStatus, Prisma, type PosOutlet } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { PosService } from './pos.service';

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

function buildPrisma(overrides: Record<string, unknown> = {}) {
  const tx = {
    reservation: {
      findFirst: jest.fn().mockResolvedValue({ id: 'res-1', currency: 'KRW' }),
    },
    folio: {
      findUnique: jest.fn().mockResolvedValue({
        id: 'fol-1',
        status: FolioStatus.OPEN,
        currency: 'KRW',
      }),
      update: jest.fn().mockResolvedValue({ balance: new Prisma.Decimal(45000) }),
    },
    posting: {
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({
        id: 'pst-1',
        reference: CHARGE.reference,
        amount: new Prisma.Decimal(45000),
        postedAt: new Date('2026-08-04T10:00:00Z'),
      }),
      update: jest.fn(),
      aggregate: jest.fn().mockResolvedValue({ _sum: { amount: new Prisma.Decimal(45000) } }),
    },
    ...(overrides.tx ?? {}),
  };

  return {
    tx,
    reservation: { findMany: jest.fn().mockResolvedValue([]) },
    posting: { findUnique: jest.fn().mockResolvedValue(null), ...(overrides.posting ?? {}) },
    $transaction: jest.fn((fn: (t: typeof tx) => unknown) => fn(tx)),
  };
}

async function buildService(prisma: ReturnType<typeof buildPrisma>) {
  const moduleRef = await Test.createTestingModule({
    providers: [PosService, { provide: PrismaService, useValue: prisma }],
  }).compile();
  return moduleRef.get(PosService);
}

describe('PosService — 룸차지', () => {
  it('재실 객실에 요금을 달고 잔액을 다시 계산한다', async () => {
    const prisma = buildPrisma();
    const service = await buildService(prisma);

    const result = await service.postCharge(OUTLET, CHARGE);

    expect(result.duplicate).toBe(false);
    expect(result.folioBalance).toBe('45000');
    const created = prisma.tx.posting.create.mock.calls[0][0].data;
    expect(created.outletId).toBe('out-1');
    expect(created.transactionCode).toBe('FNB');
    // 어느 매장에서 단 요금인지 명세서만 봐도 알아야 한다.
    expect(created.description).toBe('[1층 레스토랑] 조식 2인');
  });

  /*
   * 네트워크가 끊겨 POS 가 재전송하는 일은 흔하다. 두 번 달리면 손님에게 두 번
   * 청구되고 되돌리기 어렵다. 성공으로 보여 줘야 POS 의 재시도가 멈춘다.
   */
  it('같은 전표를 다시 보내면 새로 달지 않고 기존 것을 돌려준다', async () => {
    const prisma = buildPrisma({
      posting: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'pst-1',
          reference: CHARGE.reference,
          amount: new Prisma.Decimal(45000),
          postedAt: new Date('2026-08-04T10:00:00Z'),
          folio: { reservationId: 'res-1', window: 1, balance: new Prisma.Decimal(45000) },
        }),
      },
    });
    const service = await buildService(prisma);

    const result = await service.postCharge(OUTLET, CHARGE);

    expect(result.duplicate).toBe(true);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  // 동시에 두 번 들어오면 조회로는 못 잡는다. 고유 제약이 마지막 방어선이다.
  it('동시 전송은 고유 제약에서 걸러 409 로 알린다', async () => {
    const prisma = buildPrisma();
    prisma.tx.posting.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('duplicate', {
        code: 'P2002',
        clientVersion: '6',
      }),
    );
    const service = await buildService(prisma);

    await expect(service.postCharge(OUTLET, CHARGE)).rejects.toBeInstanceOf(ConflictException);
  });

  // 빈 객실에 요금을 달면 아무도 받지 않는 청구가 생긴다.
  it('재실 예약이 없는 객실은 거절한다', async () => {
    const prisma = buildPrisma();
    prisma.tx.reservation.findFirst.mockResolvedValue(null);
    const service = await buildService(prisma);

    await expect(service.postCharge(OUTLET, CHARGE)).rejects.toBeInstanceOf(NotFoundException);
  });

  // 마감 후 요금이 붙으면 체크아웃 시점의 잔액 0 검증이 무의미해진다.
  it('마감된 폴리오에는 달 수 없다', async () => {
    const prisma = buildPrisma();
    prisma.tx.folio.findUnique.mockResolvedValue({
      id: 'fol-1',
      status: FolioStatus.CLOSED,
      currency: 'KRW',
    });
    const service = await buildService(prisma);

    await expect(service.postCharge(OUTLET, CHARGE)).rejects.toThrow(/마감된 폴리오/);
  });

  // 다른 호텔 객실에 요금을 달 수 있으면 아웃렛 키 하나로 체인 전체가 열린다.
  it('자기 호텔 안에서만 객실을 찾는다', async () => {
    const prisma = buildPrisma();
    const service = await buildService(prisma);

    await service.postCharge(OUTLET, CHARGE);
    expect(prisma.tx.reservation.findFirst.mock.calls[0][0].where).toEqual(
      expect.objectContaining({ propertyId: 'prop-1', status: 'IN_HOUSE' }),
    );
  });
});

describe('PosService — 취소', () => {
  function voidPrisma(original: Record<string, unknown> | null) {
    const prisma = buildPrisma();
    prisma.tx.posting.findUnique = jest.fn().mockResolvedValue(original);
    prisma.tx.posting.create = jest.fn().mockResolvedValue({ id: 'pst-void' });
    prisma.tx.folio.update = jest.fn().mockResolvedValue({ balance: new Prisma.Decimal(0) });
    return prisma;
  }

  // 지우면 손님 명세서에서 요금이 통째로 사라져 무엇이 정정됐는지 설명할 수 없다.
  it('원본을 지우지 않고 반대 부호 조정을 단다', async () => {
    const prisma = voidPrisma({
      id: 'pst-1',
      folioId: 'fol-1',
      transactionCode: 'FNB',
      description: '[1층 레스토랑] 조식 2인',
      amount: new Prisma.Decimal(45000),
      currency: 'KRW',
      folio: { status: FolioStatus.OPEN },
      voidedById: null,
    });
    const service = await buildService(prisma);

    const result = await service.voidCharge(OUTLET, { reference: 'CHK-1001' });

    const reversal = prisma.tx.posting.create.mock.calls[0][0].data;
    expect(reversal.amount.toString()).toBe('-45000');
    expect(reversal.type).toBe('ADJUSTMENT');
    // 취소에도 전표를 붙여 둔다. 취소 요청이 재전송되면 여기서 걸린다.
    expect(reversal.reference).toBe('CHK-1001-VOID');
    expect(prisma.tx.posting.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { voidedById: 'pst-void' } }),
    );
    expect(result.balance).toBe('0');
  });

  /*
   * voidedById 가 이 포스팅을 취소한 조정을 가리킨다. 반대 방향 관계를 보면
   * "이 조정이 취소한 원본" 이 나와 언제나 비어 있어, 두 번째 취소가 검사에
   * 걸리지 않고 고유 제약에서 터진다.
   */
  it('이미 취소된 전표는 다시 취소할 수 없다', async () => {
    const prisma = voidPrisma({
      id: 'pst-1',
      folioId: 'fol-1',
      amount: new Prisma.Decimal(45000),
      folio: { status: FolioStatus.OPEN },
      voidedById: 'pst-void',
    });
    const service = await buildService(prisma);

    await expect(service.voidCharge(OUTLET, { reference: 'CHK-1001' })).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(prisma.tx.posting.create).not.toHaveBeenCalled();
  });

  // 위 검사로는 동시 요청을 못 잡는다. 고유 제약이 마지막 방어선이다.
  it('동시 취소 요청은 고유 제약에서 걸러 409 로 알린다', async () => {
    const prisma = voidPrisma({
      id: 'pst-1',
      folioId: 'fol-1',
      transactionCode: 'FNB',
      description: '[1층 레스토랑] 조식 2인',
      amount: new Prisma.Decimal(45000),
      currency: 'KRW',
      folio: { status: FolioStatus.OPEN },
      voidedById: null,
    });
    prisma.tx.posting.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('duplicate', {
        code: 'P2002',
        clientVersion: '6',
      }),
    );
    const service = await buildService(prisma);

    await expect(service.voidCharge(OUTLET, { reference: 'CHK-1001' })).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('없는 전표는 404 로 알린다', async () => {
    const service = await buildService(voidPrisma(null));
    await expect(service.voidCharge(OUTLET, { reference: 'NOPE' })).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('마감된 폴리오는 취소할 수 없다', async () => {
    const prisma = voidPrisma({
      id: 'pst-1',
      folioId: 'fol-1',
      amount: new Prisma.Decimal(45000),
      folio: { status: FolioStatus.CLOSED },
      voids: null,
    });
    const service = await buildService(prisma);

    await expect(service.voidCharge(OUTLET, { reference: 'CHK-1001' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});

describe('PosService — 객실 목록', () => {
  // 매장 단말에 손님 명단이 통째로 뜨면 그 자체로 유출이다.
  it('객실 번호와 성만 준다', async () => {
    const prisma = buildPrisma();
    prisma.reservation.findMany.mockResolvedValue([
      { assignedRoomNumber: '1203', profile: { lastName: '김' } },
    ]);
    const service = await buildService(prisma);

    const result = await service.chargeableRooms(OUTLET);
    expect(result.items).toEqual([{ roomNumber: '1203', guestLastName: '김' }]);
    expect(prisma.reservation.findMany.mock.calls[0][0].select).toEqual({
      assignedRoomNumber: true,
      profile: { select: { lastName: true } },
    });
  });

  it('자기 호텔의 재실 예약만 본다', async () => {
    const prisma = buildPrisma();
    const service = await buildService(prisma);

    await service.chargeableRooms(OUTLET);
    expect(prisma.reservation.findMany.mock.calls[0][0].where).toEqual(
      expect.objectContaining({ propertyId: 'prop-1', status: 'IN_HOUSE' }),
    );
  });
});
