import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import {
  FolioStatus,
  Prisma,
  ReservationStatus,
  RoomStatus,
  type Reservation,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { parseDateOnly } from '../sync/reservation.mapper';
import type { CheckInDto, CheckOutDto } from './dto/front-desk.dto';
import type { ListReservationsDto } from './dto/list-reservations.dto';

/** 체크인을 허용하는 출발 상태. */
const CHECK_IN_ALLOWED: ReservationStatus[] = [
  ReservationStatus.RESERVED,
  ReservationStatus.CONFIRMED,
];

const RESERVATION_INCLUDE = {
  profile: true,
  roomType: true,
  ratePlan: true,
  property: true,
} satisfies Prisma.ReservationInclude;

@Injectable()
export class ReservationsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(query: ListReservationsDto) {
    const { propertyId, status, arrivalFrom, arrivalTo, q, limit = 50, offset = 0 } = query;

    const where: Prisma.ReservationWhereInput = {
      ...(propertyId ? { propertyId } : {}),
      ...(status ? { status } : {}),
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

  async findOne(id: string) {
    const reservation = await this.prisma.reservation.findUnique({
      where: { id },
      include: { ...RESERVATION_INCLUDE, folios: { include: { postings: true } } },
    });

    if (!reservation) {
      throw new NotFoundException(`예약을 찾을 수 없습니다: ${id}`);
    }
    return reservation;
  }

  /**
   * 체크인.
   *
   * 객실 배정·예약 상태·폴리오 생성이 함께 성립해야 하므로 한 트랜잭션으로 처리한다.
   * 이미 다른 예약이 쓰고 있는 객실은 배정하지 않는다.
   */
  async checkIn(id: string, dto: CheckInDto): Promise<Reservation> {
    return this.prisma.$transaction(async (tx) => {
      const reservation = await tx.reservation.findUnique({ where: { id } });
      if (!reservation) {
        throw new NotFoundException(`예약을 찾을 수 없습니다: ${id}`);
      }

      if (!CHECK_IN_ALLOWED.includes(reservation.status)) {
        throw new BadRequestException(
          `현재 상태(${reservation.status})에서는 체크인할 수 없습니다.`,
        );
      }

      const roomNumber = dto.roomNumber ?? reservation.assignedRoomNumber;
      if (!roomNumber) {
        throw new BadRequestException('배정할 객실 번호가 없습니다.');
      }

      const room = await tx.room.findUnique({
        where: { propertyId_number: { propertyId: reservation.propertyId, number: roomNumber } },
      });
      if (!room) {
        throw new NotFoundException(`객실을 찾을 수 없습니다: ${roomNumber}`);
      }
      if (room.occupied && reservation.assignedRoomNumber !== roomNumber) {
        throw new BadRequestException(`객실 ${roomNumber} 은 이미 사용 중입니다.`);
      }
      if (room.status === RoomStatus.OUT_OF_ORDER || room.status === RoomStatus.OUT_OF_SERVICE) {
        throw new BadRequestException(
          `객실 ${roomNumber} 은 판매 불가 상태(${room.status})입니다.`,
        );
      }

      await tx.room.update({ where: { id: room.id }, data: { occupied: true } });

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
        data: { status: ReservationStatus.IN_HOUSE, assignedRoomNumber: roomNumber },
      });
    });
  }

  /**
   * 체크아웃.
   *
   * 미결제 잔액이 남아 있으면 막는다 — 회계상 잔액이 있는 폴리오를 닫으면
   * 매출 누락으로 이어진다.
   */
  async checkOut(id: string, dto: CheckOutDto): Promise<Reservation> {
    return this.prisma.$transaction(async (tx) => {
      const reservation = await tx.reservation.findUnique({
        where: { id },
        include: { folios: true },
      });
      if (!reservation) {
        throw new NotFoundException(`예약을 찾을 수 없습니다: ${id}`);
      }
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
          status: ReservationStatus.CHECKED_OUT,
          ...(dto.notes ? { notes: dto.notes } : {}),
        },
      });
    });
  }

  /** 당일 도착·출발·재실 요약. 프론트데스크 대시보드용. */
  async dailySummary(propertyId: string, date: string) {
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
}
