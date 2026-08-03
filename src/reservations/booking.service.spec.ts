import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { SyncDirection, SyncStatus, UserRole } from '@prisma/client';
import type { AuthUser } from '../auth/auth.constants';
import { CoreClient } from '../core/core.client';
import type { CoreReservation } from '../core/core.types';
import { PrismaService } from '../prisma/prisma.service';
import { BookingService } from './booking.service';

const PROPERTY = {
  id: 'prop-1',
  operaHotelId: 'SAND01',
  name: 'PlanForge Seoul',
  currency: 'KRW',
};

/** 소속 없는 본사 계정. 호텔 범위 검사는 property-scope.spec.ts 가 따로 다룬다. */
const HQ: AuthUser = {
  id: 'u1',
  sub: 'u1',
  email: 'a@b.c',
  name: '본사',
  role: UserRole.MANAGER,
  propertyId: null,
};

const OPERA_RESULT: CoreReservation = {
  reservationId: 'OPERA-2001',
  confirmationNumber: 'OP2001',
  hotelId: 'SAND01',
  status: 'Reserved',
  arrivalDate: '2026-09-01',
  departureDate: '2026-09-03',
  roomTypeCode: 'DLXK',
  ratePlanCode: 'BAR',
  adults: 2,
  children: 0,
  totalAmount: 480000,
  currency: 'KRW',
  guest: { profileId: 'PRF-1', firstName: 'Gildong', lastName: 'Hong' },
};

function buildPrisma() {
  return {
    property: { findUnique: jest.fn().mockResolvedValue(PROPERTY) },
    reservation: {
      findUnique: jest.fn(),
      upsert: jest.fn().mockImplementation(({ create, update }) => ({
        id: 'res-1',
        ...update,
        ...create,
      })),
    },
    roomType: { upsert: jest.fn().mockResolvedValue({ id: 'rt-1' }) },
    ratePlan: { upsert: jest.fn().mockResolvedValue({ id: 'rp-1' }) },
    profile: {
      upsert: jest.fn().mockResolvedValue({ id: 'pf-1' }),
      findFirst: jest.fn(),
      create: jest.fn().mockResolvedValue({ id: 'pf-new' }),
    },
    syncLog: {
      create: jest.fn().mockResolvedValue({ id: 'log-1' }),
      update: jest.fn(),
    },
  };
}

function buildCore() {
  return {
    getAvailability: jest.fn().mockResolvedValue({ hotelId: 'SAND01', items: [] }),
    getRates: jest.fn().mockResolvedValue({ hotelId: 'SAND01', offers: [] }),
    createReservation: jest.fn().mockResolvedValue(OPERA_RESULT),
    updateReservation: jest.fn().mockResolvedValue(OPERA_RESULT),
    cancelReservation: jest
      .fn()
      .mockResolvedValue({ ...OPERA_RESULT, status: 'Cancelled' as const }),
  };
}

async function buildService(
  prisma: ReturnType<typeof buildPrisma>,
  core: ReturnType<typeof buildCore>,
) {
  const moduleRef = await Test.createTestingModule({
    providers: [
      BookingService,
      { provide: PrismaService, useValue: prisma },
      { provide: CoreClient, useValue: core },
    ],
  }).compile();
  return moduleRef.get(BookingService);
}

const VALID_INPUT = {
  propertyId: 'prop-1',
  arrivalDate: '2026-09-01',
  departureDate: '2026-09-03',
  roomTypeCode: 'DLXK',
  adults: 2,
  guest: { firstName: 'Gildong', lastName: 'Hong' },
};

describe('BookingService — 생성', () => {
  it('OPERA 에 만들고 돌아온 결과를 미러링한다', async () => {
    const prisma = buildPrisma();
    const core = buildCore();
    const service = await buildService(prisma, core);

    await service.create(VALID_INPUT, HQ);

    expect(core.createReservation).toHaveBeenCalledWith(
      expect.objectContaining({ hotelId: 'SAND01', roomTypeCode: 'DLXK' }),
    );
    const upsert = prisma.reservation.upsert.mock.calls[0][0];
    expect(upsert.where).toEqual({ operaReservationId: 'OPERA-2001' });
    expect(upsert.create.confirmationNumber).toBe('OP2001');
  });

  // 로컬 값은 캐시다. 우리가 보낸 값이 아니라 OPERA 가 확정한 값을 써야 갈리지 않는다.
  it('보낸 값이 아니라 OPERA 가 확정한 값을 저장한다', async () => {
    const prisma = buildPrisma();
    const core = buildCore();
    core.createReservation.mockResolvedValue({
      ...OPERA_RESULT,
      roomTypeCode: 'SUIT', // OPERA 가 다른 타입으로 확정
      totalAmount: 800000,
    });
    const service = await buildService(prisma, core);

    await service.create(VALID_INPUT, HQ);

    expect(prisma.roomType.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { propertyId_code: { propertyId: 'prop-1', code: 'SUIT' } },
      }),
    );
    expect(prisma.reservation.upsert.mock.calls[0][0].create.totalAmount.toString()).toBe('800000');
  });

  it('출발일이 도착일보다 앞서면 OPERA 를 부르지 않는다', async () => {
    const prisma = buildPrisma();
    const core = buildCore();
    const service = await buildService(prisma, core);

    await expect(
      service.create({ ...VALID_INPUT, arrivalDate: '2026-09-05' }, HQ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(core.createReservation).not.toHaveBeenCalled();
  });

  it('성공하면 PUSH 이력을 SUCCESS 로 닫는다', async () => {
    const prisma = buildPrisma();
    const service = await buildService(prisma, buildCore());

    await service.create(VALID_INPUT, HQ);

    expect(prisma.syncLog.create.mock.calls[0][0].data.direction).toBe(SyncDirection.PUSH);
    expect(prisma.syncLog.update.mock.calls[0][0].data.status).toBe(SyncStatus.SUCCESS);
  });

  it('OPERA 가 실패하면 이력을 FAILED 로 남기고 로컬을 건드리지 않는다', async () => {
    const prisma = buildPrisma();
    const core = buildCore();
    core.createReservation.mockRejectedValue(new Error('재고 없음'));
    const service = await buildService(prisma, core);

    await expect(service.create(VALID_INPUT, HQ)).rejects.toThrow(/재고 없음/);
    expect(prisma.reservation.upsert).not.toHaveBeenCalled();
    expect(prisma.syncLog.update.mock.calls[0][0].data.status).toBe(SyncStatus.FAILED);
    expect(prisma.syncLog.update.mock.calls[0][0].data.error).toMatch(/재고 없음/);
  });
});

describe('BookingService — 수정·취소', () => {
  function linked() {
    const prisma = buildPrisma();
    prisma.reservation.findUnique.mockResolvedValue({
      id: 'res-1',
      propertyId: 'prop-1',
      operaReservationId: 'OPERA-2001',
      property: PROPERTY,
    });
    return prisma;
  }

  it('OPERA 예약 번호로 수정을 위임한다', async () => {
    const prisma = linked();
    const core = buildCore();
    const service = await buildService(prisma, core);

    await service.update('res-1', { roomTypeCode: 'SUIT' }, HQ);

    expect(core.updateReservation).toHaveBeenCalledWith('OPERA-2001', { roomTypeCode: 'SUIT' });
  });

  it('취소를 위임하고 결과 상태를 미러링한다', async () => {
    const prisma = linked();
    const core = buildCore();
    const service = await buildService(prisma, core);

    await service.cancel('res-1', { reason: '고객 요청' }, HQ);

    expect(core.cancelReservation).toHaveBeenCalledWith('OPERA-2001', '고객 요청');
    expect(prisma.reservation.upsert.mock.calls[0][0].update.status).toBe('CANCELLED');
  });

  // OPERA 에 없는 예약을 로컬에서만 고치면 두 쪽이 영구히 갈린다.
  it('OPERA 와 연결되지 않은 예약은 수정할 수 없다', async () => {
    const prisma = buildPrisma();
    prisma.reservation.findUnique.mockResolvedValue({
      id: 'res-1',
      propertyId: 'prop-1',
      operaReservationId: null,
      property: PROPERTY,
    });
    const core = buildCore();
    const service = await buildService(prisma, core);

    await expect(service.update('res-1', { adults: 3 }, HQ)).rejects.toThrow(/연결되지 않은/);
    expect(core.updateReservation).not.toHaveBeenCalled();
  });

  it('없는 예약이면 404 를 낸다', async () => {
    const prisma = buildPrisma();
    prisma.reservation.findUnique.mockResolvedValue(null);
    const service = await buildService(prisma, buildCore());

    await expect(service.cancel('nope', {}, HQ)).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('BookingService — 가용성·요금', () => {
  it('계산하지 않고 OPERA 호텔 코드로 위임한다', async () => {
    const prisma = buildPrisma();
    const core = buildCore();
    const service = await buildService(prisma, core);

    await service.checkAvailability(
      { propertyId: 'prop-1', arrivalDate: '2026-09-01', departureDate: '2026-09-03' },
      HQ,
    );

    expect(core.getAvailability).toHaveBeenCalledWith(
      expect.objectContaining({ hotelId: 'SAND01' }),
    );
  });

  it('호텔을 특정할 수 없으면 거절한다', async () => {
    const prisma = buildPrisma();
    const core = buildCore();
    const service = await buildService(prisma, core);

    await expect(
      service.getRates({ arrivalDate: '2026-09-01', departureDate: '2026-09-03' }, HQ),
    ).rejects.toThrow(/호텔을 선택/);
    expect(core.getRates).not.toHaveBeenCalled();
  });
});
