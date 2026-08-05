import { BadRequestException, Injectable } from '@nestjs/common';
import { FolioStatus, Prisma, ReservationStatus, type PosOutlet } from '@prisma/client';
import { CoreClient } from '../core/core.client';
import type { CoreFolio } from '../core/core.types';
import { mirrorFolios } from '../folios/folio-mirror';
import { PrismaService } from '../prisma/prisma.service';
import type { PostRoomChargeDto, VoidRoomChargeDto } from './dto/pos.dto';
import { isUniqueViolation } from '../common/prisma-errors';
import { badRequest, conflict, notFound } from '../common/errors';

/**
 * Room charges from outside POS.
 *
 * An outlet can do exactly two things — post a charge to an occupied room and void
 * a charge it posted. It cannot read reservations or take guest details. The
 * terminal sits in a shop and must be treated as physically unsafe.
 *
 * Charges land on the OPERA folio. Recorded locally only, OPERA's bill and our
 * balance diverge and the guest receives two different statements.
 */
@Injectable()
export class PosService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly core: CoreClient,
  ) {}

  /**
   * Rooms that can be charged right now.
   *
   * Only the surname is given. A full guest list on a shop terminal is a leak in
   * itself, and confirming "Mr Kim in 1203" needs nothing more.
   */
  async chargeableRooms(outlet: PosOutlet) {
    const reservations = await this.prisma.reservation.findMany({
      where: {
        propertyId: outlet.propertyId,
        status: ReservationStatus.IN_HOUSE,
        assignedRoomNumber: { not: null },
      },
      select: {
        assignedRoomNumber: true,
        profile: { select: { lastName: true } },
      },
      orderBy: { assignedRoomNumber: 'asc' },
    });

    return {
      outlet: { code: outlet.code, name: outlet.name },
      items: reservations.map((r) => ({
        roomNumber: r.assignedRoomNumber,
        guestLastName: r.profile.lastName ?? '',
      })),
    };
  }

  /**
   * Room charge.
   *
   * One check from one outlet posts once. A POS resending after a network drop is
   * common and a double charge is hard to undo. On a resend nothing new is posted
   * and the existing charge is returned — the POS has to see success for its
   * retries to stop.
   */
  async postCharge(outlet: PosOutlet, dto: PostRoomChargeDto) {
    // Resends are cut off here first. OPERA will not post the same check twice
    // either, but there is no reason to spend a call on a retry we already know.
    const existing = await this.prisma.posting.findUnique({
      where: { outletId_reference: { outletId: outlet.id, reference: dto.reference } },
      include: { folio: { select: { reservationId: true, window: true, balance: true } } },
    });
    if (existing) {
      return { duplicate: true, ...this.toReceipt(existing, existing.folio) };
    }

    const transactionCode = dto.transactionCode ?? outlet.transactionCode;

    const reservation = await this.prisma.reservation.findFirst({
      where: {
        propertyId: outlet.propertyId,
        assignedRoomNumber: dto.roomNumber,
        status: ReservationStatus.IN_HOUSE,
      },
      select: { id: true, currency: true, operaReservationId: true, property: true },
    });
    if (!reservation) {
      // Charging an empty room creates a bill nobody will pay.
      throw notFound('POS_ROOM_NOT_IN_HOUSE', { room: dto.roomNumber });
    }
    if (!reservation.operaReservationId) {
      throw badRequest('POS_RESERVATION_NOT_LINKED', { room: dto.roomNumber });
    }

    /*
     * Routing instructions decide the window.
     *
     * A POS terminal does not know this reservation's billing split. Where the
     * company pays the room and the guest pays extras, trusting the window the
     * terminal sent puts the charge on the wrong side. A window the terminal did
     * specify is respected — window 1 is used only when no instruction applies.
     */
    const routing = dto.window
      ? null
      : await this.prisma.folioRouting.findUnique({
          where: {
            reservationId_transactionCode: { reservationId: reservation.id, transactionCode },
          },
          select: { targetWindow: true },
        });
    const window = dto.window ?? routing?.targetWindow ?? 1;

    let folio: CoreFolio;
    try {
      folio = await this.core.createPosting(reservation.operaReservationId, window, {
        hotelId: reservation.property.operaHotelId,
        type: 'Charge',
        transactionCode,
        description: `[${outlet.name}] ${dto.description}`,
        amount: dto.amount,
        reference: dto.reference,
      });
    } catch (error) {
      throw this.describeFolioFailure(error, dto.roomNumber);
    }

    return this.prisma.$transaction(async (tx) => {
      await mirrorFolios(tx, reservation.id, reservation.currency, [folio]);

      const posting = await tx.posting.findFirst({
        where: { folio: { reservationId: reservation.id, window }, reference: dto.reference },
      });
      if (!posting) {
        // OPERA accepted it but our copy lacks it, so the mapping is off. Passed over
        // silently, a charge remains that can be neither voided nor reconciled.
        throw badRequest('POS_CHARGE_NOT_MIRRORED');
      }

      // OPERA does not know which outlet posted it. That stays only in our copy.
      if (posting.outletId !== outlet.id) {
        try {
          await tx.posting.update({ where: { id: posting.id }, data: { outletId: outlet.id } });
        } catch (error) {
          // The same check arriving twice at once. The unique constraint stops it.
          if (isUniqueViolation(error)) {
            throw conflict('POS_CHECK_ALREADY_USED', { reference: dto.reference });
          }
          throw error;
        }
      }

      return {
        duplicate: false,
        ...this.toReceipt(posting, {
          reservationId: reservation.id,
          window,
          balance: new Prisma.Decimal(folio.balance),
        }),
      };
    });
  }

  /**
   * Room charge void.
   *
   * The original is kept and an opposite-signed adjustment is added. Deleted, the
   * charge vanishes from the guest's bill and no correction can be explained.
   */
  async voidCharge(outlet: PosOutlet, dto: VoidRoomChargeDto) {
    const original = await this.prisma.posting.findUnique({
      where: { outletId_reference: { outletId: outlet.id, reference: dto.reference } },
      include: { folio: { include: { reservation: { include: { property: true } } } } },
    });
    if (!original) {
      throw notFound('POS_CHECK_NOT_FOUND', { reference: dto.reference });
    }
    // voidedById points at the adjustment that voided this posting. The reverse
    // relation gives "the original this adjustment voided" and is always empty here.
    if (original.voidedById) {
      throw conflict('POS_CHECK_ALREADY_VOIDED', { reference: dto.reference });
    }
    if (original.folio.status === FolioStatus.CLOSED) {
      throw badRequest('POS_FOLIO_CLOSED');
    }
    if (!original.operaPostingId) {
      throw badRequest('POS_POSTING_NOT_LINKED');
    }

    const reservation = original.folio.reservation;
    if (!reservation.operaReservationId) {
      throw badRequest('POS_RESERVATION_NOT_LINKED_PLAIN');
    }

    let folio: CoreFolio;
    try {
      folio = await this.core.voidPosting(reservation.operaReservationId, original.operaPostingId, {
        hotelId: reservation.property.operaHotelId,
        ...(dto.reason ? { reason: dto.reason } : {}),
        // The void carries a check number too, so a resent void is caught here.
        reference: `${dto.reference}-VOID`,
      });
    } catch (error) {
      throw this.describeFolioFailure(error, reservation.assignedRoomNumber ?? '');
    }

    return this.prisma.$transaction(async (tx) => {
      await mirrorFolios(tx, reservation.id, reservation.currency, [folio]);

      const reversal = await tx.posting.findFirst({
        where: { folioId: original.folioId, reference: `${dto.reference}-VOID` },
      });
      if (reversal && reversal.outletId !== outlet.id) {
        await tx.posting.update({ where: { id: reversal.id }, data: { outletId: outlet.id } });
      }

      return {
        reference: dto.reference,
        voidedAmount: original.amount.toString(),
        balance: folio.balance.toString(),
      };
    });
  }

  // ---------------------------------------------------------------------------

  /**
   * Turns an OPERA rejection into something the terminal can show.
   *
   * Shop staff do not know what a folio window is. "Ask the front desk" is what
   * tells them what to do next.
   */
  private describeFolioFailure(error: unknown, roomNumber: string): Error {
    const message = error instanceof Error ? error.message : String(error);
    if (/마감/.test(message)) {
      return badRequest('POS_FOLIO_CLOSED_ROOM', { room: roomNumber });
    }
    if (/열려 있지 않/.test(message)) {
      return notFound('POS_FOLIO_NOT_FOUND', { room: roomNumber, reason: message });
    }
    return error instanceof Error ? error : new BadRequestException(message);
  }

  private toReceipt(
    posting: { id: string; reference: string | null; amount: Prisma.Decimal; postedAt: Date },
    folio: { reservationId: string; window: number; balance: Prisma.Decimal },
  ) {
    return {
      postingId: posting.id,
      reference: posting.reference,
      amount: posting.amount.toString(),
      postedAt: posting.postedAt,
      reservationId: folio.reservationId,
      window: folio.window,
      folioBalance: folio.balance.toString(),
    };
  }
}
