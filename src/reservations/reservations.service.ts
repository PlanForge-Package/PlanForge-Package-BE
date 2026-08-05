import { Injectable } from '@nestjs/common';
import {
  FolioStatus,
  Prisma,
  ReservationStatus,
  RoomStatus,
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
import { finishSyncLog, startSyncLog } from '../sync/sync-log';
import { badRequest, notFound } from '../common/errors';

/** Statuses a check-in may start from. */
const CHECK_IN_ALLOWED: ReservationStatus[] = [
  ReservationStatus.RESERVED,
  ReservationStatus.CONFIRMED,
];

/**
 * Front-desk actions need the reservation to exist in OPERA.
 *
 * Changed locally only, OPERA still believes the guest never arrived and assigns
 * that room to someone else. Sync comes first.
 */
function assertLinked(operaReservationId: string | null): string {
  if (!operaReservationId) {
    throw badRequest('RESERVATION_NOT_LINKED');
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
      throw notFound('RESERVATION_NOT_FOUND', { id: id });
    }

    // Lists are filtered by scope, but one record is reachable from its id alone.
    // A leaked confirmation number or URL must not open another hotel's reservation.
    assertWithinScope(user, reservation.propertyId);
    return reservation;
  }

  /**
   * Check-in.
   *
   * Which room the guest walked into is inventory itself, so OPERA has to know.
   * Recorded locally only, OPERA still sees the room free and assigns it again.
   *
   * Hence the fixed order: reject obviously wrong requests locally, kill the keys
   * for a changed room, delegate the check-in to OPERA, then copy back only what
   * came in reply. The external call stays out of the transaction because a slow
   * response would hold a DB transaction open for its duration.
   */
  async checkIn(id: string, dto: CheckInDto, user: AuthUser): Promise<Reservation> {
    const reservation = await this.prisma.reservation.findUnique({
      where: { id },
      include: { property: true },
    });
    if (!reservation) {
      throw notFound('RESERVATION_NOT_FOUND', { id: id });
    }
    assertWithinScope(user, reservation.propertyId);

    if (!CHECK_IN_ALLOWED.includes(reservation.status)) {
      throw badRequest('CHECK_IN_NOT_ALLOWED', { status: reservation.status });
    }

    const operaId = assertLinked(reservation.operaReservationId);

    const roomNumber = dto.roomNumber ?? reservation.assignedRoomNumber;
    if (!roomNumber) {
      throw badRequest('ROOM_NUMBER_REQUIRED');
    }

    const room = await this.prisma.room.findUnique({
      where: { propertyId_number: { propertyId: reservation.propertyId, number: roomNumber } },
    });
    if (!room) {
      throw notFound('ROOM_NOT_FOUND', { room: roomNumber });
    }
    /*
     * A room already in use is not assigned again.
     *
     * Shares are the exception — two guests in one room settling separately is
     * exactly what a share is. OPERA applies the same rule.
     */
    if (room.occupied && reservation.assignedRoomNumber !== roomNumber) {
      const sharing = reservation.shareGroupId
        ? await this.prisma.reservation.findFirst({
            where: {
              propertyId: reservation.propertyId,
              shareGroupId: reservation.shareGroupId,
              assignedRoomNumber: roomNumber,
              id: { not: id },
            },
            select: { id: true },
          })
        : null;

      if (!sharing) {
        throw badRequest('ROOM_OCCUPIED', { room: roomNumber });
      }
    }
    if (room.status === RoomStatus.OUT_OF_ORDER || room.status === RoomStatus.OUT_OF_SERVICE) {
      throw badRequest('ROOM_NOT_SELLABLE', { room: roomNumber, status: room.status });
    }

    /*
     * On a room change, the old room's keys are killed first.
     *
     * Left alive, the guest keeps opening the old door, and another guest moves in
     * there shortly. It runs before the OPERA call because failing to kill a key
     * must also mean the room is not changed.
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

    // The status and room OPERA confirmed are copied over, not the ones we sent.
    const assignedRoomNumber = confirmed.roomNumber ?? roomNumber;

    return this.prisma.$transaction(async (tx) => {
      await tx.room.updateMany({
        where: { propertyId: reservation.propertyId, number: assignedRoomNumber },
        data: { occupied: true },
      });

      // Created only when absent — a re-check-in must not lose existing transactions.
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
   * Check-out.
   *
   * An outstanding balance blocks it — closing a folio that still owes money leads
   * straight to missing revenue.
   */
  async checkOut(id: string, dto: CheckOutDto, user: AuthUser): Promise<Reservation> {
    const reservation = await this.prisma.reservation.findUnique({
      where: { id },
      include: { folios: true, property: true },
    });
    if (!reservation) {
      throw notFound('RESERVATION_NOT_FOUND', { id: id });
    }
    assertWithinScope(user, reservation.propertyId);
    if (reservation.status !== ReservationStatus.IN_HOUSE) {
      throw badRequest('CHECK_OUT_NOT_ALLOWED', { status: reservation.status });
    }

    const outstanding = reservation.folios
      .filter((folio) => folio.status === FolioStatus.OPEN)
      .reduce((sum, folio) => sum.add(folio.balance), new Prisma.Decimal(0));

    if (!outstanding.isZero()) {
      throw badRequest('BALANCE_OUTSTANDING', { amount: outstanding.toString() });
    }

    const operaId = assertLinked(reservation.operaReservationId);

    /*
     * The departing guest's keys are always killed.
     *
     * The most dangerous failure in this domain — left alive, a departed guest opens
     * the room the next guest is in. It runs before the OPERA call so that a key we
     * could not kill stops the check-out from happening at all.
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

    /*
     * OPERA closes the folio too.
     *
     * Closed locally only, OPERA's bill stays open and charges can keep landing.
     * The check-out itself is already settled above, so a failed close is logged
     * rather than rolled back — the guest has left and reverting is riskier.
     */
    for (const folio of reservation.folios.filter((f) => f.status === FolioStatus.OPEN)) {
      try {
        await this.core.closeFolio(operaId, folio.window, {
          hotelId: reservation.property.operaHotelId,
        });
      } catch (error) {
        const closeLog = await this.startLog(id, { action: 'closeFolio', window: folio.window });
        await this.finishLog(closeLog.id, SyncStatus.FAILED, error);
      }
    }

    return this.prisma.$transaction(async (tx) => {
      await tx.folio.updateMany({
        where: { reservationId: id, status: FolioStatus.OPEN },
        data: { status: FolioStatus.CLOSED },
      });

      if (reservation.assignedRoomNumber) {
        // A checked-out room goes back to needing cleaning.
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

  /** Today's arrivals, departures and in-house counts, for the front-desk dashboard. */
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

  private startLog(reservationId: string | null, payload: unknown) {
    return startSyncLog(this.prisma, 'Reservation', reservationId, payload);
  }

  private finishLog(id: string, status: SyncStatus, error?: unknown): Promise<void> {
    return finishSyncLog(this.prisma, id, status, { error });
  }
}
