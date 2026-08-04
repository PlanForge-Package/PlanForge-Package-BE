import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { FolioStatus, Prisma, ReservationStatus, RoomStatus, UserRole } from '@prisma/client';
import { CoreClient } from '../core/core.client';
import { DoorLockService } from '../doorlock/doorlock.service';
import { PrismaService } from '../prisma/prisma.service';
import { ReservationsService } from './reservations.service';

/** Transaction client mock passed straight into the $transaction callback. */
function buildTx(overrides: Record<string, unknown> = {}) {
  return {
    reservation: { update: jest.fn() },
    room: { update: jest.fn(), updateMany: jest.fn() },
    folio: { upsert: jest.fn(), updateMany: jest.fn() },
    ...overrides,
  };
}

/**
 * Door locks are verified separately (doorlock.service.spec.ts).
 *
 * Here we only check that check-out and room change **call** key voiding — without
 * it, a departed guest's card opens the next guest's room.
 */
function buildDoorLock() {
  return { revokeActive: jest.fn().mockResolvedValue(0) };
}

/**
 * OPERA sits behind Core.
 *
 * The default mock confirms the room we sent. This checks both that delegation
 * actually happens and that a rejection is not applied locally.
 */
function buildCore(overrides: Record<string, unknown> = {}) {
  return {
    checkInReservation: jest
      .fn()
      .mockImplementation((_id: string, input: { roomNumber: string }) => ({
        reservationId: 'RSV-1001',
        status: 'InHouse',
        roomNumber: input.roomNumber,
      })),
    checkOutReservation: jest
      .fn()
      .mockResolvedValue({ reservationId: 'RSV-1001', status: 'CheckedOut' }),
    ...overrides,
  };
}

function buildPrisma(tx: ReturnType<typeof buildTx>, overrides: Record<string, unknown> = {}) {
  return {
    reservation: {
      findUnique: jest.fn(),
      // Checks whether the share partner is in that room.
      findFirst: jest.fn().mockResolvedValue(null),
      ...((overrides.reservation as object) ?? {}),
    },
    room: {
      findUnique: jest.fn(),
      ...((overrides.room as object) ?? {}),
    },
    syncLog: {
      create: jest.fn().mockResolvedValue({ id: 'log-1' }),
      update: jest.fn().mockResolvedValue({}),
    },
    $transaction: jest.fn((cb: (client: unknown) => unknown) => cb(tx)),
  };
}

async function buildService(
  prisma: ReturnType<typeof buildPrisma>,
  doorLock: ReturnType<typeof buildDoorLock> = buildDoorLock(),
  core: ReturnType<typeof buildCore> = buildCore(),
) {
  const moduleRef = await Test.createTestingModule({
    providers: [
      ReservationsService,
      { provide: PrismaService, useValue: prisma },
      { provide: CoreClient, useValue: core },
      { provide: DoorLockService, useValue: doorLock },
    ],
  }).compile();

  return moduleRef.get(ReservationsService);
}

/** Account with no property. Hotel scoping is covered by property-scope.spec.ts. */
const ACTOR = {
  id: 'actor-1',
  sub: 'actor-1',
  email: 'actor@planforge.local',
  name: '검사자',
  role: UserRole.MANAGER,
  propertyId: null,
} as const;

const PROPERTY = { id: 'prop-1', operaHotelId: 'SAND01' };

const BASE_RESERVATION = {
  id: 'res-1',
  propertyId: 'prop-1',
  operaReservationId: 'RSV-1001',
  status: ReservationStatus.CONFIRMED,
  assignedRoomNumber: null as string | null,
  currency: 'KRW',
  property: PROPERTY,
};

const CLEAN_ROOM = {
  id: 'room-1',
  number: '1203',
  occupied: false,
  status: RoomStatus.CLEAN,
};

describe('ReservationsService', () => {
  describe('checkIn', () => {
    it('OPERA 에 위임한 뒤 배정·재실·폴리오를 반영한다', async () => {
      const tx = buildTx();
      const prisma = buildPrisma(tx);
      prisma.reservation.findUnique.mockResolvedValue(BASE_RESERVATION);
      prisma.room.findUnique.mockResolvedValue(CLEAN_ROOM);
      tx.reservation.update.mockResolvedValue({
        ...BASE_RESERVATION,
        status: ReservationStatus.IN_HOUSE,
      });

      const core = buildCore();
      const service = await buildService(prisma, buildDoorLock(), core);
      await service.checkIn('res-1', { roomNumber: '1203' }, ACTOR);

      expect(core.checkInReservation).toHaveBeenCalledWith('RSV-1001', {
        hotelId: 'SAND01',
        roomNumber: '1203',
      });
      expect(tx.room.updateMany).toHaveBeenCalledWith({
        where: { propertyId: 'prop-1', number: '1203' },
        data: { occupied: true },
      });
      expect(tx.folio.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { reservationId_window: { reservationId: 'res-1', window: 1 } },
        }),
      );
      expect(tx.reservation.update).toHaveBeenCalledWith({
        where: { id: 'res-1' },
        data: { status: ReservationStatus.IN_HOUSE, assignedRoomNumber: '1203' },
      });
    });

    // Their confirmed value is the reference, not the one we sent.
    it('OPERA 가 다른 객실로 확정하면 그 객실을 따른다', async () => {
      const tx = buildTx();
      const prisma = buildPrisma(tx);
      prisma.reservation.findUnique.mockResolvedValue(BASE_RESERVATION);
      prisma.room.findUnique.mockResolvedValue(CLEAN_ROOM);
      tx.reservation.update.mockResolvedValue({ id: 'res-1' });

      const core = buildCore({
        checkInReservation: jest
          .fn()
          .mockResolvedValue({ reservationId: 'RSV-1001', status: 'InHouse', roomNumber: '1204' }),
      });
      const service = await buildService(prisma, buildDoorLock(), core);
      await service.checkIn('res-1', { roomNumber: '1203' }, ACTOR);

      expect(tx.reservation.update).toHaveBeenCalledWith({
        where: { id: 'res-1' },
        data: { status: ReservationStatus.IN_HOUSE, assignedRoomNumber: '1204' },
      });
    });

    it('OPERA 가 거절하면 로컬에 반영하지 않는다', async () => {
      const tx = buildTx();
      const prisma = buildPrisma(tx);
      prisma.reservation.findUnique.mockResolvedValue(BASE_RESERVATION);
      prisma.room.findUnique.mockResolvedValue(CLEAN_ROOM);

      const core = buildCore({
        checkInReservation: jest.fn().mockRejectedValue(new BadRequestException('도착일이 아직')),
      });
      const service = await buildService(prisma, buildDoorLock(), core);

      await expect(service.checkIn('res-1', { roomNumber: '1203' }, ACTOR)).rejects.toThrow(
        /도착일/,
      );
      expect(tx.reservation.update).not.toHaveBeenCalled();
      expect(tx.room.updateMany).not.toHaveBeenCalled();
    });

    it('OPERA 에 연결되지 않은 예약은 막는다', async () => {
      const tx = buildTx();
      const prisma = buildPrisma(tx);
      prisma.reservation.findUnique.mockResolvedValue({
        ...BASE_RESERVATION,
        operaReservationId: null,
      });
      prisma.room.findUnique.mockResolvedValue(CLEAN_ROOM);

      const core = buildCore();
      const service = await buildService(prisma, buildDoorLock(), core);

      await expect(service.checkIn('res-1', { roomNumber: '1203' }, ACTOR)).rejects.toThrow(
        /동기화/,
      );
      expect(core.checkInReservation).not.toHaveBeenCalled();
    });

    it('이미 체크인된 예약은 거절한다', async () => {
      const tx = buildTx();
      const prisma = buildPrisma(tx);
      prisma.reservation.findUnique.mockResolvedValue({
        ...BASE_RESERVATION,
        status: ReservationStatus.IN_HOUSE,
      });

      const service = await buildService(prisma);
      await expect(service.checkIn('res-1', {}, ACTOR)).rejects.toBeInstanceOf(BadRequestException);
      expect(tx.room.updateMany).not.toHaveBeenCalled();
    });

    it('다른 예약이 쓰고 있는 객실은 배정하지 않는다', async () => {
      const tx = buildTx();
      const prisma = buildPrisma(tx);
      prisma.reservation.findUnique.mockResolvedValue(BASE_RESERVATION);
      prisma.room.findUnique.mockResolvedValue({ ...CLEAN_ROOM, occupied: true });

      const service = await buildService(prisma);
      await expect(service.checkIn('res-1', { roomNumber: '1203' }, ACTOR)).rejects.toThrow(
        /사용 중/,
      );
    });

    it('판매 불가 객실은 배정하지 않는다', async () => {
      const tx = buildTx();
      const prisma = buildPrisma(tx);
      prisma.reservation.findUnique.mockResolvedValue(BASE_RESERVATION);
      prisma.room.findUnique.mockResolvedValue({
        ...CLEAN_ROOM,
        status: RoomStatus.OUT_OF_ORDER,
      });

      const service = await buildService(prisma);
      await expect(service.checkIn('res-1', { roomNumber: '1203' }, ACTOR)).rejects.toThrow(
        /판매 불가/,
      );
    });

    /*
     * Left alive, the guest keeps opening the old door, and another guest moves in
     * there shortly.
     */
    it('객실이 바뀌면 이전 방 카드를 무효화한다', async () => {
      const tx = buildTx();
      const prisma = buildPrisma(tx);
      prisma.reservation.findUnique.mockResolvedValue({
        ...BASE_RESERVATION,
        assignedRoomNumber: '1101',
      });
      prisma.room.findUnique.mockResolvedValue(CLEAN_ROOM);
      tx.reservation.update.mockResolvedValue({ id: 'res-1' });

      const doorLock = buildDoorLock();
      const service = await buildService(prisma, doorLock);
      await service.checkIn('res-1', { roomNumber: '1203' }, ACTOR);

      expect(doorLock.revokeActive).toHaveBeenCalledWith('res-1', '객실 변경 1101 → 1203');
    });

    // A key we could not kill must also mean the room is not changed.
    it('카드를 못 죽이면 OPERA 에 위임하지 않는다', async () => {
      const tx = buildTx();
      const prisma = buildPrisma(tx);
      prisma.reservation.findUnique.mockResolvedValue({
        ...BASE_RESERVATION,
        assignedRoomNumber: '1101',
      });
      prisma.room.findUnique.mockResolvedValue(CLEAN_ROOM);

      const doorLock = buildDoorLock();
      doorLock.revokeActive.mockRejectedValue(new Error('잠금장치 연결 실패'));
      const core = buildCore();
      const service = await buildService(prisma, doorLock, core);

      await expect(service.checkIn('res-1', { roomNumber: '1203' }, ACTOR)).rejects.toThrow(
        /잠금장치/,
      );
      expect(core.checkInReservation).not.toHaveBeenCalled();
    });

    it('같은 객실로 다시 체크인하면 카드를 죽이지 않는다', async () => {
      const tx = buildTx();
      const prisma = buildPrisma(tx);
      prisma.reservation.findUnique.mockResolvedValue({
        ...BASE_RESERVATION,
        assignedRoomNumber: '1203',
      });
      prisma.room.findUnique.mockResolvedValue(CLEAN_ROOM);
      tx.reservation.update.mockResolvedValue({ id: 'res-1' });

      const doorLock = buildDoorLock();
      const service = await buildService(prisma, doorLock);
      await service.checkIn('res-1', { roomNumber: '1203' }, ACTOR);

      expect(doorLock.revokeActive).not.toHaveBeenCalled();
    });

    it('배정할 객실 번호가 전혀 없으면 거절한다', async () => {
      const tx = buildTx();
      const prisma = buildPrisma(tx);
      prisma.reservation.findUnique.mockResolvedValue(BASE_RESERVATION);

      const service = await buildService(prisma);
      await expect(service.checkIn('res-1', {}, ACTOR)).rejects.toThrow(/객실 번호가 없습니다/);
    });

    it('없는 예약이면 404 를 낸다', async () => {
      const tx = buildTx();
      const prisma = buildPrisma(tx);
      prisma.reservation.findUnique.mockResolvedValue(null);

      const service = await buildService(prisma);
      await expect(service.checkIn('nope', {}, ACTOR)).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('checkOut', () => {
    const IN_HOUSE = {
      ...BASE_RESERVATION,
      status: ReservationStatus.IN_HOUSE,
      assignedRoomNumber: '1203',
    };

    it('OPERA 에 위임한 뒤 폴리오를 닫고 객실을 청소 대상으로 되돌린다', async () => {
      const tx = buildTx();
      const prisma = buildPrisma(tx);
      prisma.reservation.findUnique.mockResolvedValue({
        ...IN_HOUSE,
        folios: [{ status: FolioStatus.OPEN, balance: new Prisma.Decimal(0) }],
      });
      tx.reservation.update.mockResolvedValue({
        ...IN_HOUSE,
        status: ReservationStatus.CHECKED_OUT,
      });

      const core = buildCore();
      const service = await buildService(prisma, buildDoorLock(), core);
      await service.checkOut('res-1', {}, ACTOR);

      expect(core.checkOutReservation).toHaveBeenCalledWith('RSV-1001', { hotelId: 'SAND01' });
      expect(tx.folio.updateMany).toHaveBeenCalledWith({
        where: { reservationId: 'res-1', status: FolioStatus.OPEN },
        data: { status: FolioStatus.CLOSED },
      });
      expect(tx.room.updateMany).toHaveBeenCalledWith({
        where: { propertyId: 'prop-1', number: '1203' },
        data: { occupied: false, status: RoomStatus.DIRTY },
      });
      expect(tx.reservation.update).toHaveBeenCalledWith({
        where: { id: 'res-1' },
        data: { status: ReservationStatus.CHECKED_OUT },
      });
    });

    it('OPERA 가 거절하면 폴리오를 닫지 않는다', async () => {
      const tx = buildTx();
      const prisma = buildPrisma(tx);
      prisma.reservation.findUnique.mockResolvedValue({ ...IN_HOUSE, folios: [] });

      const core = buildCore({
        checkOutReservation: jest.fn().mockRejectedValue(new BadRequestException('마감 중')),
      });
      const service = await buildService(prisma, buildDoorLock(), core);

      await expect(service.checkOut('res-1', {}, ACTOR)).rejects.toThrow(/마감 중/);
      expect(tx.folio.updateMany).not.toHaveBeenCalled();
    });

    /*
     * The most dangerous failure in this domain. Left alive, a departed guest opens
     * the room the next guest is in.
     */
    it('나가는 손님의 카드를 무효화한다', async () => {
      const tx = buildTx();
      const prisma = buildPrisma(tx);
      prisma.reservation.findUnique.mockResolvedValue({ ...IN_HOUSE, folios: [] });
      tx.reservation.update.mockResolvedValue({
        ...IN_HOUSE,
        status: ReservationStatus.CHECKED_OUT,
      });

      const doorLock = buildDoorLock();
      const service = await buildService(prisma, doorLock);
      await service.checkOut('res-1', {}, ACTOR);

      expect(doorLock.revokeActive).toHaveBeenCalledWith('res-1', '체크아웃');
    });

    it('카드를 못 죽이면 체크아웃도 되돌린다', async () => {
      const tx = buildTx();
      const prisma = buildPrisma(tx);
      prisma.reservation.findUnique.mockResolvedValue({ ...IN_HOUSE, folios: [] });

      const doorLock = buildDoorLock();
      doorLock.revokeActive.mockRejectedValue(new Error('잠금장치 연결 실패'));
      const core = buildCore();
      const service = await buildService(prisma, doorLock, core);

      await expect(service.checkOut('res-1', {}, ACTOR)).rejects.toThrow(/잠금장치/);
      expect(core.checkOutReservation).not.toHaveBeenCalled();
      expect(tx.folio.updateMany).not.toHaveBeenCalled();
    });

    it('미결제 잔액이 남아 있으면 막는다', async () => {
      const tx = buildTx();
      const prisma = buildPrisma(tx);
      prisma.reservation.findUnique.mockResolvedValue({
        ...IN_HOUSE,
        folios: [{ status: FolioStatus.OPEN, balance: new Prisma.Decimal(120000) }],
      });

      const service = await buildService(prisma);
      await expect(service.checkOut('res-1', {}, ACTOR)).rejects.toThrow(/미결제 잔액/);
      expect(tx.folio.updateMany).not.toHaveBeenCalled();
    });

    it('이미 마감된 폴리오 잔액은 계산에서 뺀다', async () => {
      const tx = buildTx();
      const prisma = buildPrisma(tx);
      prisma.reservation.findUnique.mockResolvedValue({
        ...IN_HOUSE,
        folios: [
          { status: FolioStatus.CLOSED, balance: new Prisma.Decimal(50000) },
          { status: FolioStatus.OPEN, balance: new Prisma.Decimal(0) },
        ],
      });
      tx.reservation.update.mockResolvedValue(IN_HOUSE);

      const service = await buildService(prisma);
      await expect(service.checkOut('res-1', {}, ACTOR)).resolves.toBeDefined();
    });

    it('재실 상태가 아니면 거절한다', async () => {
      const tx = buildTx();
      const prisma = buildPrisma(tx);
      prisma.reservation.findUnique.mockResolvedValue({
        ...IN_HOUSE,
        status: ReservationStatus.RESERVED,
        folios: [],
      });

      const service = await buildService(prisma);
      await expect(service.checkOut('res-1', {}, ACTOR)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });
  });
});

describe('ReservationsService — 객실 공유', () => {
  const OCCUPIED = { id: 'room-1', number: '1203', occupied: true, status: RoomStatus.CLEAN };

  /*
   * Two guests in one room settling separately is exactly what a share is. OPERA
   * applies the same rule.
   */
  it('공유 상대가 든 방에는 함께 들어간다', async () => {
    const tx = buildTx();
    const prisma = buildPrisma(tx);
    prisma.reservation.findUnique.mockResolvedValue({
      ...BASE_RESERVATION,
      shareGroupId: 'SHR-901',
    });
    prisma.reservation.findFirst.mockResolvedValue({ id: 'res-2' });
    prisma.room.findUnique.mockResolvedValue(OCCUPIED);
    tx.reservation.update.mockResolvedValue({ id: 'res-1' });

    const core = buildCore();
    const service = await buildService(prisma, buildDoorLock(), core);

    await expect(service.checkIn('res-1', { roomNumber: '1203' }, ACTOR)).resolves.toBeDefined();
    expect(core.checkInReservation).toHaveBeenCalled();
  });

  it('공유가 아니면 든 방에 들어가지 못한다', async () => {
    const tx = buildTx();
    const prisma = buildPrisma(tx);
    prisma.reservation.findUnique.mockResolvedValue(BASE_RESERVATION);
    prisma.room.findUnique.mockResolvedValue(OCCUPIED);

    const service = await buildService(prisma);

    await expect(service.checkIn('res-1', { roomNumber: '1203' }, ACTOR)).rejects.toThrow(
      /사용 중/,
    );
  });

  // Even within a group, anyone but the partner in that room is a stranger to it.
  it('같은 묶음이어도 다른 방이면 막는다', async () => {
    const tx = buildTx();
    const prisma = buildPrisma(tx);
    prisma.reservation.findUnique.mockResolvedValue({
      ...BASE_RESERVATION,
      shareGroupId: 'SHR-901',
    });
    prisma.reservation.findFirst.mockResolvedValue(null);
    prisma.room.findUnique.mockResolvedValue(OCCUPIED);

    const service = await buildService(prisma);

    await expect(service.checkIn('res-1', { roomNumber: '1203' }, ACTOR)).rejects.toThrow(
      /사용 중/,
    );
  });
});
