import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';

// Mirroring itself is covered separately by folio-mirror.spec.ts.
jest.mock('../folios/folio-mirror', () => ({
  mirrorFolios: jest.fn().mockResolvedValue(undefined),
}));
import { ReservationStatus, SyncDirection, SyncStatus, UserRole } from '@prisma/client';
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

/** Head-office account with no property. Hotel scoping is covered by property-scope.spec.ts. */
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
    // A cancellation penalty mirrors the folio within one transaction.
    $transaction: jest.fn((cb: (client: unknown) => unknown) => cb({})),
    reservation: {
      findUnique: jest.fn(),
      // Unshare clears the flag on the partner left alone.
      findMany: jest.fn().mockResolvedValue([]),
      update: jest.fn().mockResolvedValue({}),
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
      findFirst: jest.fn().mockResolvedValue(null),
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
    confirmWaitlist: jest.fn().mockResolvedValue({ ...OPERA_RESULT, status: 'Confirmed' as const }),
    shareReservation: jest.fn().mockResolvedValue({
      shareGroupId: 'SHR-901',
      reservations: [
        { ...OPERA_RESULT, shareGroupId: 'SHR-901' },
        { ...OPERA_RESULT, reservationId: 'OPERA-2002', shareGroupId: 'SHR-901' },
      ],
    }),
    unshareReservation: jest.fn().mockResolvedValue({ ...OPERA_RESULT, shareGroupId: undefined }),
    getReservationPolicies: jest.fn().mockResolvedValue({
      reservationId: 'OPERA-2001',
      guaranteeCode: 'SIXPM',
      currency: 'KRW',
      cancellation: {
        policyName: '도착 1일 전 18시까지 무료',
        freeUntil: '2026-08-10T18:00:00.000Z',
        withinFreeWindow: true,
        penaltyAmount: 0,
      },
      deposit: { requiredAmount: 0, paidAmount: 0 },
    }),
    setGuarantee: jest
      .fn()
      .mockResolvedValue({ ...OPERA_RESULT, guaranteeCode: 'CREDITCARD' as const }),
    // A penalty means the folio is re-read and mirrored.
    listFolios: jest.fn().mockResolvedValue({ reservationId: 'OPERA-2001', folios: [] }),
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

  /*
   * Without it OPERA creates a new profile every time. Each returning guest gains
   * another, stay history scatters, and someone ends up merging by hand.
   */
  it('이미 아는 이메일이면 그 OPERA 프로필 ID 를 함께 보낸다', async () => {
    const prisma = buildPrisma();
    prisma.profile.findFirst.mockResolvedValue({ operaProfileId: 'PRF-EXISTING' });
    const core = buildCore();
    const service = await buildService(prisma, core);

    await service.create(
      { ...VALID_INPUT, guest: { ...VALID_INPUT.guest, email: 'repeat@example.com' } },
      HQ,
    );

    expect(core.createReservation.mock.calls[0][0].guest.profileId).toBe('PRF-EXISTING');
  });

  it('처음 보는 손님이면 프로필 ID 없이 보낸다', async () => {
    const prisma = buildPrisma();
    const core = buildCore();
    const service = await buildService(prisma, core);

    await service.create(VALID_INPUT, HQ);
    expect(core.createReservation.mock.calls[0][0].guest.profileId).toBeUndefined();
  });

  // Attaching a merged profile revives the duplicate just cleaned up.
  it('병합된 프로필은 후보에서 제외한다', async () => {
    const prisma = buildPrisma();
    const service = await buildService(prisma, buildCore());

    await service.create(
      { ...VALID_INPUT, guest: { ...VALID_INPUT.guest, email: 'repeat@example.com' } },
      HQ,
    );

    expect(prisma.profile.findFirst.mock.calls[0][0].where).toEqual(
      expect.objectContaining({ mergedIntoId: null }),
    );
  });

  // Local values are a cache. Writing OPERA's confirmed value, not ours, keeps them in step.
  it('보낸 값이 아니라 OPERA 가 확정한 값을 저장한다', async () => {
    const prisma = buildPrisma();
    const core = buildCore();
    core.createReservation.mockResolvedValue({
      ...OPERA_RESULT,
      roomTypeCode: 'SUIT', // OPERA confirmed a different type
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

  // Fixing a reservation OPERA does not have splits the two sides permanently.
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

describe('BookingService — 대기 확정', () => {
  function waitlisted() {
    return {
      id: 'res-1',
      propertyId: 'prop-1',
      operaReservationId: 'OPERA-2001',
      status: ReservationStatus.WAITLISTED,
      property: PROPERTY,
    };
  }

  it('OPERA 에 확정을 맡긴다', async () => {
    const prisma = buildPrisma();
    prisma.reservation.findUnique.mockResolvedValue(waitlisted());
    const core = buildCore();
    const service = await buildService(prisma, core);

    await service.confirmWaitlist('res-1', HQ);

    expect(core.confirmWaitlist).toHaveBeenCalledWith('OPERA-2001', 'SAND01');
  });

  it('대기 상태가 아니면 호출하지 않는다', async () => {
    const prisma = buildPrisma();
    prisma.reservation.findUnique.mockResolvedValue({
      ...waitlisted(),
      status: ReservationStatus.CONFIRMED,
    });
    const core = buildCore();
    const service = await buildService(prisma, core);

    await expect(service.confirmWaitlist('res-1', HQ)).rejects.toThrow(/대기 상태가 아닙니다/);
    expect(core.confirmWaitlist).not.toHaveBeenCalled();
  });

  /*
   * Another waitlisted booking may have been confirmed in between. OPERA decides
   * that, and its rejection is surfaced as is.
   */
  it('OPERA 가 거절하면 그대로 올린다', async () => {
    const prisma = buildPrisma();
    prisma.reservation.findUnique.mockResolvedValue(waitlisted());
    const core = buildCore();
    core.confirmWaitlist.mockRejectedValue(new ConflictException('아직 빈 객실이 없습니다.'));
    const service = await buildService(prisma, core);

    await expect(service.confirmWaitlist('res-1', HQ)).rejects.toThrow(/빈 객실이 없습니다/);
    expect(prisma.syncLog.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: SyncStatus.FAILED }) }),
    );
  });

  // Rather than turning a guest away when sold out, take them on the waitlist.
  it('생성 시 대기 여부를 그대로 넘긴다', async () => {
    const prisma = buildPrisma();
    const core = buildCore();
    const service = await buildService(prisma, core);

    await service.create({ ...VALID_INPUT, waitlist: true }, HQ);

    expect(core.createReservation.mock.calls[0][0].waitlist).toBe(true);
  });
});

describe('BookingService — 객실 공유', () => {
  function linked(overrides: Record<string, unknown> = {}) {
    return {
      id: 'res-1',
      propertyId: 'prop-1',
      operaReservationId: 'OPERA-2001',
      status: ReservationStatus.CONFIRMED,
      shareGroupId: null,
      property: PROPERTY,
      ...overrides,
    };
  }

  it('OPERA 에 묶음을 맡기고 둘 다 옮겨 적는다', async () => {
    const prisma = buildPrisma();
    prisma.reservation.findUnique
      .mockResolvedValueOnce(linked())
      .mockResolvedValueOnce(linked({ id: 'res-2', operaReservationId: 'OPERA-2002' }));
    const core = buildCore();
    const service = await buildService(prisma, core);

    const result = await service.share('res-1', 'res-2', HQ);

    expect(core.shareReservation).toHaveBeenCalledWith('OPERA-2001', {
      hotelId: 'SAND01',
      withReservationId: 'OPERA-2002',
    });
    expect(result).toHaveLength(2);
  });

  // Different hotels cannot share a room. Blocked before the external call.
  it('다른 호텔의 예약과는 묶지 않는다', async () => {
    const prisma = buildPrisma();
    prisma.reservation.findUnique
      .mockResolvedValueOnce(linked())
      .mockResolvedValueOnce(linked({ id: 'res-2', propertyId: 'prop-2' }));
    const core = buildCore();
    const service = await buildService(prisma, core);

    await expect(service.share('res-1', 'res-2', HQ)).rejects.toThrow(/다른 호텔/);
    expect(core.shareReservation).not.toHaveBeenCalled();
  });

  /*
   * Overlapping dates and matching room types are OPERA's call. The side that
   * knows inventory and room assignment has to decide.
   */
  it('OPERA 가 거절하면 그대로 올린다', async () => {
    const prisma = buildPrisma();
    prisma.reservation.findUnique
      .mockResolvedValueOnce(linked())
      .mockResolvedValueOnce(linked({ id: 'res-2', operaReservationId: 'OPERA-2002' }));
    const core = buildCore();
    core.shareReservation.mockRejectedValue(new BadRequestException('객실 타입이 다릅니다.'));
    const service = await buildService(prisma, core);

    await expect(service.share('res-1', 'res-2', HQ)).rejects.toThrow(/객실 타입이 다릅니다/);
  });

  it('공유 중이 아니면 해제하지 않는다', async () => {
    const prisma = buildPrisma();
    prisma.reservation.findUnique.mockResolvedValue(linked());
    const core = buildCore();
    const service = await buildService(prisma, core);

    await expect(service.unshare('res-1', HQ)).rejects.toThrow(/공유 중인 예약이 아닙니다/);
    expect(core.unshareReservation).not.toHaveBeenCalled();
  });

  /*
   * OPERA already cleared it, but that reservation is not in the response. Left in
   * our copy, it would look shared when it is not.
   */
  it('혼자 남은 상대의 표시도 푼다', async () => {
    const prisma = buildPrisma();
    prisma.reservation.findUnique.mockResolvedValue(linked({ shareGroupId: 'SHR-901' }));
    prisma.reservation.findMany.mockResolvedValue([{ id: 'res-2' }]);
    const core = buildCore();
    const service = await buildService(prisma, core);

    await service.unshare('res-1', HQ);

    expect(prisma.reservation.update).toHaveBeenCalledWith({
      where: { id: 'res-2' },
      data: { shareGroupId: null },
    });
  });

  it('둘 넘게 남았으면 표시를 그대로 둔다', async () => {
    const prisma = buildPrisma();
    prisma.reservation.findUnique.mockResolvedValue(linked({ shareGroupId: 'SHR-901' }));
    prisma.reservation.findMany.mockResolvedValue([{ id: 'res-2' }, { id: 'res-3' }]);
    const core = buildCore();
    const service = await buildService(prisma, core);

    await service.unshare('res-1', HQ);

    expect(prisma.reservation.update).not.toHaveBeenCalled();
  });
});

describe('BookingService — 보증·취소 조건', () => {
  /** A reservation already linked to OPERA. Guarantee and cancellation terms need the link. */
  function linkedPrisma() {
    const prisma = buildPrisma();
    prisma.reservation.findUnique.mockResolvedValue({
      id: 'res-1',
      propertyId: 'prop-1',
      operaReservationId: 'OPERA-2001',
      property: PROPERTY,
      currency: 'KRW',
    });
    return prisma;
  }

  it('취소 조건은 OPERA 에 묻는다', async () => {
    const prisma = linkedPrisma();
    const core = buildCore();
    const service = await buildService(prisma, core);

    const result = await service.policies('res-1', HQ);

    expect(core.getReservationPolicies).toHaveBeenCalledWith('OPERA-2001', 'SAND01');
    expect(result.cancellation.withinFreeWindow).toBe(true);
  });

  // The screen calls back with the local id. Returning the OPERA id breaks the link.
  it('로컬 예약 id 를 돌려준다', async () => {
    const prisma = linkedPrisma();
    const core = buildCore();
    const service = await buildService(prisma, core);

    const result = await service.policies('res-1', HQ);
    expect(result.reservationId).toBe('res-1');
  });

  it('보증 방식을 바꾸면 사본에도 옮겨 적는다', async () => {
    const prisma = linkedPrisma();
    const core = buildCore();
    const service = await buildService(prisma, core);

    await service.setGuarantee('res-1', 'CREDITCARD', HQ);

    expect(core.setGuarantee).toHaveBeenCalledWith('OPERA-2001', 'CREDITCARD', 'SAND01');
    expect(prisma.reservation.upsert.mock.calls[0][0].update.guaranteeCode).toBe('CREDITCARD');
  });

  // Without recording the failure there is no telling later why nothing changed.
  it('보증 방식 변경 실패도 기록한다', async () => {
    const prisma = linkedPrisma();
    const core = buildCore();
    core.setGuarantee.mockRejectedValue(new Error('알 수 없는 보증 방식'));
    const service = await buildService(prisma, core);

    await expect(service.setGuarantee('res-1', 'NOPE', HQ)).rejects.toThrow(/보증 방식/);
    expect(prisma.syncLog.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'FAILED' }) }),
    );
  });

  it('취소 위약금을 사본에 옮겨 적는다', async () => {
    const prisma = linkedPrisma();
    const core = buildCore();
    core.cancelReservation.mockResolvedValue({
      ...OPERA_RESULT,
      status: 'Cancelled' as const,
      cancellationPenalty: 120000,
    });
    const service = await buildService(prisma, core);

    await service.cancel('res-1', { reason: '손님 요청' }, HQ);

    const saved = prisma.reservation.upsert.mock.calls[0][0].update;
    expect(saved.cancellationPenalty.toString()).toBe('120000');
    // Without mirroring, a charge exists only in OPERA and never on our screen.
    expect(core.listFolios).toHaveBeenCalledWith('OPERA-2001');
  });
});
