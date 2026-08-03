import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { FolioStatus, Prisma, ReservationStatus, RoomStatus, UserRole } from '@prisma/client';
import { DoorLockService } from '../doorlock/doorlock.service';
import { PrismaService } from '../prisma/prisma.service';
import { ReservationsService } from './reservations.service';

/** $transaction 콜백에 그대로 넘길 트랜잭션 클라이언트 목. */
function buildTx(overrides: Record<string, unknown> = {}) {
  return {
    reservation: { findUnique: jest.fn(), update: jest.fn() },
    room: { findUnique: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
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

async function buildService(
  tx: ReturnType<typeof buildTx>,
  doorLock: ReturnType<typeof buildDoorLock> = buildDoorLock(),
) {
  const prisma = {
    $transaction: jest.fn((cb: (client: unknown) => unknown) => cb(tx)),
  };

  const moduleRef = await Test.createTestingModule({
    providers: [
      ReservationsService,
      { provide: PrismaService, useValue: prisma },
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

const BASE_RESERVATION = {
  id: 'res-1',
  propertyId: 'prop-1',
  status: ReservationStatus.CONFIRMED,
  assignedRoomNumber: null as string | null,
  currency: 'KRW',
};

const CLEAN_ROOM = {
  id: 'room-1',
  number: '1203',
  occupied: false,
  status: RoomStatus.CLEAN,
};

describe('ReservationsService', () => {
  describe('checkIn', () => {
    it('객실을 배정하고 재실 처리한 뒤 폴리오를 연다', async () => {
      const tx = buildTx();
      tx.reservation.findUnique.mockResolvedValue(BASE_RESERVATION);
      tx.room.findUnique.mockResolvedValue(CLEAN_ROOM);
      tx.reservation.update.mockResolvedValue({
        ...BASE_RESERVATION,
        status: ReservationStatus.IN_HOUSE,
      });

      const service = await buildService(tx);
      await service.checkIn('res-1', { roomNumber: '1203' }, ACTOR);

      expect(tx.room.update).toHaveBeenCalledWith({
        where: { id: 'room-1' },
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

    it('이미 체크인된 예약은 거절한다', async () => {
      const tx = buildTx();
      tx.reservation.findUnique.mockResolvedValue({
        ...BASE_RESERVATION,
        status: ReservationStatus.IN_HOUSE,
      });

      const service = await buildService(tx);
      await expect(service.checkIn('res-1', {}, ACTOR)).rejects.toBeInstanceOf(BadRequestException);
      expect(tx.room.update).not.toHaveBeenCalled();
    });

    it('다른 예약이 쓰고 있는 객실은 배정하지 않는다', async () => {
      const tx = buildTx();
      tx.reservation.findUnique.mockResolvedValue(BASE_RESERVATION);
      tx.room.findUnique.mockResolvedValue({ ...CLEAN_ROOM, occupied: true });

      const service = await buildService(tx);
      await expect(service.checkIn('res-1', { roomNumber: '1203' }, ACTOR)).rejects.toThrow(
        /사용 중/,
      );
    });

    it('판매 불가 객실은 배정하지 않는다', async () => {
      const tx = buildTx();
      tx.reservation.findUnique.mockResolvedValue(BASE_RESERVATION);
      tx.room.findUnique.mockResolvedValue({
        ...CLEAN_ROOM,
        status: RoomStatus.OUT_OF_ORDER,
      });

      const service = await buildService(tx);
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
      tx.reservation.findUnique.mockResolvedValue({
        ...BASE_RESERVATION,
        assignedRoomNumber: '1101',
      });
      tx.room.findUnique.mockResolvedValue(CLEAN_ROOM);
      tx.reservation.update.mockResolvedValue({ id: 'res-1' });

      const doorLock = buildDoorLock();
      const service = await buildService(tx, doorLock);
      await service.checkIn('res-1', { roomNumber: '1203' }, ACTOR);

      expect(doorLock.revokeActive).toHaveBeenCalledWith('res-1', '객실 변경 1101 → 1203');
    });

    it('같은 객실로 다시 체크인하면 카드를 죽이지 않는다', async () => {
      const tx = buildTx();
      tx.reservation.findUnique.mockResolvedValue({
        ...BASE_RESERVATION,
        assignedRoomNumber: '1203',
      });
      tx.room.findUnique.mockResolvedValue(CLEAN_ROOM);
      tx.reservation.update.mockResolvedValue({ id: 'res-1' });

      const doorLock = buildDoorLock();
      const service = await buildService(tx, doorLock);
      await service.checkIn('res-1', { roomNumber: '1203' }, ACTOR);

      expect(doorLock.revokeActive).not.toHaveBeenCalled();
    });

    it('배정할 객실 번호가 전혀 없으면 거절한다', async () => {
      const tx = buildTx();
      tx.reservation.findUnique.mockResolvedValue(BASE_RESERVATION);

      const service = await buildService(tx);
      await expect(service.checkIn('res-1', {}, ACTOR)).rejects.toThrow(/객실 번호가 없습니다/);
    });

    it('없는 예약이면 404 를 낸다', async () => {
      const tx = buildTx();
      tx.reservation.findUnique.mockResolvedValue(null);

      const service = await buildService(tx);
      await expect(service.checkIn('nope', {}, ACTOR)).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('checkOut', () => {
    const IN_HOUSE = {
      ...BASE_RESERVATION,
      status: ReservationStatus.IN_HOUSE,
      assignedRoomNumber: '1203',
    };

    it('잔액이 0 이면 폴리오를 닫고 객실을 청소 대상으로 되돌린다', async () => {
      const tx = buildTx();
      tx.reservation.findUnique.mockResolvedValue({
        ...IN_HOUSE,
        folios: [{ status: FolioStatus.OPEN, balance: new Prisma.Decimal(0) }],
      });
      tx.reservation.update.mockResolvedValue({
        ...IN_HOUSE,
        status: ReservationStatus.CHECKED_OUT,
      });

      const service = await buildService(tx);
      await service.checkOut('res-1', {}, ACTOR);

      expect(tx.folio.updateMany).toHaveBeenCalledWith({
        where: { reservationId: 'res-1', status: FolioStatus.OPEN },
        data: { status: FolioStatus.CLOSED },
      });
      expect(tx.room.updateMany).toHaveBeenCalledWith({
        where: { propertyId: 'prop-1', number: '1203' },
        data: { occupied: false, status: RoomStatus.DIRTY },
      });
    });

    /*
     * 이 도메인에서 가장 위험한 실패다. 살려 두면 체크아웃한 손님이 다음 손님이
     * 들어온 방을 연다.
     */
    it('나가는 손님의 카드를 무효화한다', async () => {
      const tx = buildTx();
      tx.reservation.findUnique.mockResolvedValue({ ...IN_HOUSE, folios: [] });
      tx.reservation.update.mockResolvedValue({
        ...IN_HOUSE,
        status: ReservationStatus.CHECKED_OUT,
      });

      const doorLock = buildDoorLock();
      const service = await buildService(tx, doorLock);
      await service.checkOut('res-1', {}, ACTOR);

      expect(doorLock.revokeActive).toHaveBeenCalledWith('res-1', '체크아웃');
    });

    it('카드를 못 죽이면 체크아웃도 되돌린다', async () => {
      const tx = buildTx();
      tx.reservation.findUnique.mockResolvedValue({ ...IN_HOUSE, folios: [] });

      const doorLock = buildDoorLock();
      doorLock.revokeActive.mockRejectedValue(new Error('잠금장치 연결 실패'));
      const service = await buildService(tx, doorLock);

      await expect(service.checkOut('res-1', {}, ACTOR)).rejects.toThrow(/잠금장치/);
      expect(tx.folio.updateMany).not.toHaveBeenCalled();
    });

    it('미결제 잔액이 남아 있으면 막는다', async () => {
      const tx = buildTx();
      tx.reservation.findUnique.mockResolvedValue({
        ...IN_HOUSE,
        folios: [{ status: FolioStatus.OPEN, balance: new Prisma.Decimal(120000) }],
      });

      const service = await buildService(tx);
      await expect(service.checkOut('res-1', {}, ACTOR)).rejects.toThrow(/미결제 잔액/);
      expect(tx.folio.updateMany).not.toHaveBeenCalled();
    });

    it('이미 마감된 폴리오 잔액은 계산에서 뺀다', async () => {
      const tx = buildTx();
      tx.reservation.findUnique.mockResolvedValue({
        ...IN_HOUSE,
        folios: [
          { status: FolioStatus.CLOSED, balance: new Prisma.Decimal(50000) },
          { status: FolioStatus.OPEN, balance: new Prisma.Decimal(0) },
        ],
      });
      tx.reservation.update.mockResolvedValue(IN_HOUSE);

      const service = await buildService(tx);
      await expect(service.checkOut('res-1', {}, ACTOR)).resolves.toBeDefined();
    });

    it('재실 상태가 아니면 거절한다', async () => {
      const tx = buildTx();
      tx.reservation.findUnique.mockResolvedValue({
        ...IN_HOUSE,
        status: ReservationStatus.RESERVED,
        folios: [],
      });

      const service = await buildService(tx);
      await expect(service.checkOut('res-1', {}, ACTOR)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });
  });
});
