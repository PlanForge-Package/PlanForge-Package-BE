import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { FolioStatus, Prisma, ReservationStatus, RoomStatus, UserRole } from '@prisma/client';
import { CoreClient } from '../core/core.client';
import { DoorLockService } from '../doorlock/doorlock.service';
import { PrismaService } from '../prisma/prisma.service';
import { ReservationsService } from './reservations.service';

/** $transaction 콜백에 그대로 넘길 트랜잭션 클라이언트 목. */
function buildTx(overrides: Record<string, unknown> = {}) {
  return {
    reservation: { update: jest.fn() },
    room: { update: jest.fn(), updateMany: jest.fn() },
    folio: { upsert: jest.fn(), updateMany: jest.fn() },
    ...overrides,
  };
}

/**
 * 잠금장치는 따로 검증한다(doorlock.service.spec.ts).
 *
 * 여기서는 체크아웃·객실 변경이 카드 무효화를 **부르는지**만 본다 — 부르지
 * 않으면 나간 손님의 카드가 다음 손님의 방을 연다.
 */
function buildDoorLock() {
  return { revokeActive: jest.fn().mockResolvedValue(0) };
}

/**
 * OPERA 는 Core 뒤에 있다.
 *
 * 기본 목은 우리가 보낸 객실을 그대로 확정해 준다. 위임이 실제로 일어나는지와
 * 거절이 로컬에 반영되지 않는지를 함께 본다.
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
      // 공유 상대가 그 방을 쓰고 있는지 확인한다.
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

/** 소속이 없는 계정. 호텔 범위 검사는 property-scope.spec.ts 가 따로 다룬다. */
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

    // 우리가 보낸 값이 아니라 저쪽이 확정한 값이 기준이다.
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
     * 남겨 두면 손님이 예전 방 문을 계속 열 수 있고, 그 방에는 곧 다른 손님이
     * 들어온다.
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

    // 카드를 못 죽였으면 객실을 바꾸지도 말아야 한다.
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
     * 이 도메인에서 가장 위험한 실패다. 살려 두면 체크아웃한 손님이 다음 손님이
     * 들어온 방을 연다.
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
   * 두 손님이 한 방을 쓰되 계산만 따로 하는 편성이 공유다. OPERA 도 같은
   * 규칙으로 판단한다.
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

  // 같은 묶음이어도 그 방에 있는 상대가 아니면 남의 방이다.
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
