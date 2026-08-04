import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import {
  FolioStatus,
  Prisma,
  ReservationStatus,
  RoomStatus,
  SyncDirection,
  SyncStatus,
  type Reservation,
} from '@prisma/client';
import type { AuthUser } from '../auth/auth.constants';
import { CoreClient } from '../core/core.client';
import type { CoreReservation } from '../core/core.types';
import { DoorLockService } from '../doorlock/doorlock.service';
import { PrismaService } from '../prisma/prisma.service';
import { assertWithinScope, resolvePropertyScope } from '../properties/property-scope';
import { parseDateOnly, toReservationStatus } from '../sync/reservation.mapper';
import type { CheckInDto, CheckOutDto } from './dto/front-desk.dto';
import type { ListReservationsDto } from './dto/list-reservations.dto';

/** 체크인을 허용하는 출발 상태. */
const CHECK_IN_ALLOWED: ReservationStatus[] = [
  ReservationStatus.RESERVED,
  ReservationStatus.CONFIRMED,
];

/**
 * OPERA 에 없는 예약은 프론트데스크 처리를 할 수 없다.
 *
 * 로컬만 바꾸면 OPERA 는 손님이 오지 않은 것으로 알고 있고, 그 방을 다른
 * 예약에 배정한다. 동기화가 먼저다.
 */
function assertLinked(operaReservationId: string | null): string {
  if (!operaReservationId) {
    throw new BadRequestException(
      'OPERA 와 연결되지 않은 예약입니다. 먼저 동기화한 뒤 다시 시도해 주세요.',
    );
  }
  return operaReservationId;
}

const RESERVATION_INCLUDE = {
  profile: true,
  roomType: true,
  ratePlan: true,
  property: true,
} satisfies Prisma.ReservationInclude;

@Injectable()
export class ReservationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly core: CoreClient,
    private readonly doorLock: DoorLockService,
  ) {}

  async list(query: ListReservationsDto, user: AuthUser) {
    const {
      status,
      arrivalFrom,
      arrivalTo,
      q,
      sourceCode,
      channelCode,
      limit = 50,
      offset = 0,
    } = query;
    const propertyId = resolvePropertyScope(user, query.propertyId);

    const where: Prisma.ReservationWhereInput = {
      ...(propertyId ? { propertyId } : {}),
      ...(status ? { status } : {}),
      ...(sourceCode ? { sourceCode } : {}),
      ...(channelCode ? { channelCode } : {}),
      ...(arrivalFrom || arrivalTo
        ? {
            arrivalDate: {
              ...(arrivalFrom ? { gte: parseDateOnly(arrivalFrom) } : {}),
              ...(arrivalTo ? { lte: parseDateOnly(arrivalTo) } : {}),
            },
          }
        : {}),
      ...(q
        ? {
            OR: [
              { confirmationNumber: { contains: q, mode: Prisma.QueryMode.insensitive } },
              { profile: { lastName: { contains: q, mode: Prisma.QueryMode.insensitive } } },
              { profile: { firstName: { contains: q, mode: Prisma.QueryMode.insensitive } } },
            ],
          }
        : {}),
    };

    const [items, total] = await Promise.all([
      this.prisma.reservation.findMany({
        where,
        include: RESERVATION_INCLUDE,
        orderBy: [{ arrivalDate: 'asc' }, { createdAt: 'asc' }],
        take: limit,
        skip: offset,
      }),
      this.prisma.reservation.count({ where }),
    ]);

    return { items, total, limit, offset };
  }

  async findOne(id: string, user: AuthUser) {
    const reservation = await this.prisma.reservation.findUnique({
      where: { id },
      include: { ...RESERVATION_INCLUDE, folios: { include: { postings: true } } },
    });

    if (!reservation) {
      throw new NotFoundException(`예약을 찾을 수 없습니다: ${id}`);
    }

    // 목록은 범위로 걸러지지만 단건은 ID 만 알면 닿는다. 확인 번호나 URL 이
    // 새어 나가는 것만으로 남의 호텔 예약이 열리면 안 된다.
    assertWithinScope(user, reservation.propertyId);
    return reservation;
  }

  /**
   * 체크인.
   *
   * 어느 방에 손님이 들어갔는지는 재고 그 자체라 OPERA 가 알아야 한다. 로컬에만
   * 적어 두면 OPERA 는 그 방을 여전히 빈 방으로 보고 다른 예약에 배정한다.
   *
   * 그래서 순서가 정해져 있다. 로컬에서 명백히 틀린 요청을 먼저 걸러 내고,
   * 바뀐 객실의 카드를 죽인 뒤, OPERA 에 체크인을 위임하고, 돌아온 결과만
   * 옮겨 적는다. 외부 호출을 트랜잭션 안에 두지 않는 이유는 응답이 늦으면
   * 그동안 DB 트랜잭션이 열려 있기 때문이다.
   */
  async checkIn(id: string, dto: CheckInDto, user: AuthUser): Promise<Reservation> {
    const reservation = await this.prisma.reservation.findUnique({
      where: { id },
      include: { property: true },
    });
    if (!reservation) {
      throw new NotFoundException(`예약을 찾을 수 없습니다: ${id}`);
    }
    assertWithinScope(user, reservation.propertyId);

    if (!CHECK_IN_ALLOWED.includes(reservation.status)) {
      throw new BadRequestException(`현재 상태(${reservation.status})에서는 체크인할 수 없습니다.`);
    }

    const operaId = assertLinked(reservation.operaReservationId);

    const roomNumber = dto.roomNumber ?? reservation.assignedRoomNumber;
    if (!roomNumber) {
      throw new BadRequestException('배정할 객실 번호가 없습니다.');
    }

    const room = await this.prisma.room.findUnique({
      where: { propertyId_number: { propertyId: reservation.propertyId, number: roomNumber } },
    });
    if (!room) {
      throw new NotFoundException(`객실을 찾을 수 없습니다: ${roomNumber}`);
    }
    if (room.occupied && reservation.assignedRoomNumber !== roomNumber) {
      throw new BadRequestException(`객실 ${roomNumber} 은 이미 사용 중입니다.`);
    }
    if (room.status === RoomStatus.OUT_OF_ORDER || room.status === RoomStatus.OUT_OF_SERVICE) {
      throw new BadRequestException(`객실 ${roomNumber} 은 판매 불가 상태(${room.status})입니다.`);
    }

    /*
     * 객실이 바뀌면 이전 방 카드를 먼저 죽인다.
     *
     * 남겨 두면 손님이 예전 방 문을 계속 열 수 있고, 그 방에는 곧 다른 손님이
     * 들어온다. OPERA 호출보다 앞에 두는 이유는, 카드를 못 죽였으면 객실을
     * 바꾸지도 말아야 하기 때문이다.
     */
    if (reservation.assignedRoomNumber && reservation.assignedRoomNumber !== roomNumber) {
      await this.doorLock.revokeActive(
        id,
        `객실 변경 ${reservation.assignedRoomNumber} → ${roomNumber}`,
      );
    }

    const log = await this.startLog(id, { action: 'checkIn', roomNumber });

    let confirmed: CoreReservation;
    try {
      confirmed = await this.core.checkInReservation(operaId, {
        hotelId: reservation.property.operaHotelId,
        roomNumber,
      });
      await this.finishLog(log.id, SyncStatus.SUCCESS);
    } catch (error) {
      await this.finishLog(log.id, SyncStatus.FAILED, error);
      throw error;
    }

    // OPERA 가 확정한 상태와 객실을 그대로 반영한다. 우리가 보낸 값이 아니다.
    const assignedRoomNumber = confirmed.roomNumber ?? roomNumber;

    return this.prisma.$transaction(async (tx) => {
      await tx.room.updateMany({
        where: { propertyId: reservation.propertyId, number: assignedRoomNumber },
        data: { occupied: true },
      });

      // 폴리오가 없을 때만 만든다 — 재체크인 시 기존 거래 내역을 잃지 않도록.
      await tx.folio.upsert({
        where: { reservationId_window: { reservationId: id, window: 1 } },
        update: {},
        create: {
          reservationId: id,
          window: 1,
          currency: reservation.currency,
        },
      });

      return tx.reservation.update({
        where: { id },
        data: { status: toReservationStatus(confirmed.status), assignedRoomNumber },
      });
    });
  }

  /**
   * 체크아웃.
   *
   * 미결제 잔액이 남아 있으면 막는다 — 회계상 잔액이 있는 폴리오를 닫으면
   * 매출 누락으로 이어진다.
   */
  async checkOut(id: string, dto: CheckOutDto, user: AuthUser): Promise<Reservation> {
    const reservation = await this.prisma.reservation.findUnique({
      where: { id },
      include: { folios: true, property: true },
    });
    if (!reservation) {
      throw new NotFoundException(`예약을 찾을 수 없습니다: ${id}`);
    }
    assertWithinScope(user, reservation.propertyId);
    if (reservation.status !== ReservationStatus.IN_HOUSE) {
      throw new BadRequestException(
        `현재 상태(${reservation.status})에서는 체크아웃할 수 없습니다.`,
      );
    }

    const outstanding = reservation.folios
      .filter((folio) => folio.status === FolioStatus.OPEN)
      .reduce((sum, folio) => sum.add(folio.balance), new Prisma.Decimal(0));

    if (!outstanding.isZero()) {
      throw new BadRequestException(`미결제 잔액이 남아 있습니다: ${outstanding.toString()}`);
    }

    const operaId = assertLinked(reservation.operaReservationId);

    /*
     * 나가는 손님의 카드를 반드시 죽인다.
     *
     * 이 도메인에서 가장 위험한 실패다 — 살려 두면 체크아웃한 손님이 다음
     * 손님이 들어온 방을 연다. OPERA 호출보다 앞에 두어, 카드를 못 죽였으면
     * 체크아웃 자체가 일어나지 않게 한다.
     */
    await this.doorLock.revokeActive(id, '체크아웃');

    const log = await this.startLog(id, { action: 'checkOut' });

    let confirmed: CoreReservation;
    try {
      confirmed = await this.core.checkOutReservation(operaId, {
        hotelId: reservation.property.operaHotelId,
      });
      await this.finishLog(log.id, SyncStatus.SUCCESS);
    } catch (error) {
      await this.finishLog(log.id, SyncStatus.FAILED, error);
      throw error;
    }

    return this.prisma.$transaction(async (tx) => {
      await tx.folio.updateMany({
        where: { reservationId: id, status: FolioStatus.OPEN },
        data: { status: FolioStatus.CLOSED },
      });

      if (reservation.assignedRoomNumber) {
        // 체크아웃한 객실은 청소 대상으로 되돌린다.
        await tx.room.updateMany({
          where: { propertyId: reservation.propertyId, number: reservation.assignedRoomNumber },
          data: { occupied: false, status: RoomStatus.DIRTY },
        });
      }

      return tx.reservation.update({
        where: { id },
        data: {
          status: toReservationStatus(confirmed.status),
          ...(dto.notes ? { notes: dto.notes } : {}),
        },
      });
    });
  }

  /** 당일 도착·출발·재실 요약. 프론트데스크 대시보드용. */
  async dailySummary(requestedPropertyId: string, date: string, user: AuthUser) {
    const propertyId = resolvePropertyScope(user, requestedPropertyId);
    const day = parseDateOnly(date);

    const [arrivals, departures, inHouse] = await Promise.all([
      this.prisma.reservation.count({
        where: {
          propertyId,
          arrivalDate: day,
          status: { in: [ReservationStatus.RESERVED, ReservationStatus.CONFIRMED] },
        },
      }),
      this.prisma.reservation.count({
        where: { propertyId, departureDate: day, status: ReservationStatus.IN_HOUSE },
      }),
      this.prisma.reservation.count({
        where: { propertyId, status: ReservationStatus.IN_HOUSE },
      }),
    ]);

    return { propertyId, date, arrivals, departures, inHouse };
  }

  private startLog(reservationId: string, payload: unknown) {
    return this.prisma.syncLog.create({
      data: {
        entity: 'Reservation',
        entityId: reservationId,
        direction: SyncDirection.PUSH,
        status: SyncStatus.PENDING,
        payload: payload as Prisma.InputJsonValue,
      },
    });
  }

  private async finishLog(id: string, status: SyncStatus, error?: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : error ? String(error) : null;
    await this.prisma.syncLog.update({
      where: { id },
      data: { status, finishedAt: new Date(), ...(message ? { error: message } : {}) },
    });
  }
}
