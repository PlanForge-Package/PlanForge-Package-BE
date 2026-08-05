import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  Prisma,
  ReservationStatus,
  SyncStatus,
  type Property,
  type Reservation,
} from '@prisma/client';
import type { AuthUser } from '../auth/auth.constants';
import { CoreClient } from '../core/core.client';
import type { CoreReservation } from '../core/core.types';
import { mirrorFolios } from '../folios/folio-mirror';
import { PrismaService } from '../prisma/prisma.service';
import { assertWithinScope, resolvePropertyScope } from '../properties/property-scope';
import { parseDateOnly, toReservationStatus } from '../sync/reservation.mapper';
import { finishSyncLog, startSyncLog } from '../sync/sync-log';
import type {
  CancelBookingDto,
  CheckAvailabilityDto,
  CreateBookingDto,
  UpdateBookingDto,
} from './dto/booking.dto';

/**
 * Reservation create, update and cancel.
 *
 * OPERA is the system of record. Inventory, pricing and confirmation numbers are
 * decided by OPERA through Core, and the result is mirrored locally.
 *
 * Two systems computing separately eventually disagree, and in accounting data
 * there is no way to tell which side is right. So local rows are a cache.
 */
@Injectable()
export class BookingService {
  private readonly logger = new Logger(BookingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly core: CoreClient,
  ) {}

  /** Availability. Asked of OPERA rather than computed. */
  async checkAvailability(dto: CheckAvailabilityDto, user: AuthUser) {
    const property = await this.resolveProperty(dto.propertyId, user);
    this.assertDateRange(dto.arrivalDate, dto.departureDate);

    const result = await this.core.getAvailability({
      hotelId: property.operaHotelId,
      arrivalDate: dto.arrivalDate,
      departureDate: dto.departureDate,
      adults: dto.adults,
      children: dto.children,
    });

    return { propertyId: property.id, ...result };
  }

  /** Rates for a date range. Decided by OPERA as well. */
  async getRates(dto: CheckAvailabilityDto, user: AuthUser) {
    const property = await this.resolveProperty(dto.propertyId, user);
    this.assertDateRange(dto.arrivalDate, dto.departureDate);

    const result = await this.core.getRates({
      hotelId: property.operaHotelId,
      arrivalDate: dto.arrivalDate,
      departureDate: dto.departureDate,
      // Some packages are per person. Omitting the count splits quote from charge.
      adults: dto.adults,
    });

    return { propertyId: property.id, ...result };
  }

  async create(dto: CreateBookingDto, user: AuthUser): Promise<Reservation> {
    const property = await this.resolveProperty(dto.propertyId, user);
    this.assertDateRange(dto.arrivalDate, dto.departureDate);

    const log = await this.startLog('Reservation', null, {
      action: 'create',
      hotelId: property.operaHotelId,
    });

    try {
      const created = await this.core.createReservation({
        hotelId: property.operaHotelId,
        arrivalDate: dto.arrivalDate,
        departureDate: dto.departureDate,
        roomTypeCode: dto.roomTypeCode,
        ratePlanCode: dto.ratePlanCode,
        adults: dto.adults ?? 1,
        children: dto.children ?? 0,
        blockCode: dto.blockCode,
        waitlist: dto.waitlist,
        sourceCode: dto.sourceCode,
        marketCode: dto.marketCode,
        channelCode: dto.channelCode,
        guaranteeCode: dto.guaranteeCode,
        guest: {
          ...dto.guest,
          profileId: dto.guest.profileId ?? (await this.knownProfileId(dto.guest.email)),
        },
      });

      const mirrored = await this.mirror(property, created);
      await this.finishLog(log.id, SyncStatus.SUCCESS, created.reservationId);
      return mirrored;
    } catch (error) {
      await this.finishLog(log.id, SyncStatus.FAILED, null, error);
      throw error;
    }
  }

  async update(id: string, dto: UpdateBookingDto, user: AuthUser): Promise<Reservation> {
    const { reservation, property } = await this.loadLinked(id, user);

    const log = await this.startLog('Reservation', reservation.operaReservationId, {
      action: 'update',
      ...dto,
    });

    try {
      const updated = await this.core.updateReservation(reservation.operaReservationId!, dto);
      const mirrored = await this.mirror(property, updated);
      await this.finishLog(log.id, SyncStatus.SUCCESS, updated.reservationId);
      return mirrored;
    } catch (error) {
      await this.finishLog(log.id, SyncStatus.FAILED, reservation.operaReservationId, error);
      throw error;
    }
  }

  async cancel(id: string, dto: CancelBookingDto, user: AuthUser): Promise<Reservation> {
    const { reservation, property } = await this.loadLinked(id, user);

    const log = await this.startLog('Reservation', reservation.operaReservationId, {
      action: 'cancel',
      reason: dto.reason,
    });

    try {
      const cancelled = await this.core.cancelReservation(
        reservation.operaReservationId!,
        dto.reason,
      );
      const mirrored = await this.mirror(property, cancelled, dto.reason);

      /*
       * Re-read the folio when a penalty was charged.
       *
       * OPERA posts the charge while cancelling. Without copying it over, the
       * charge exists only there and we never know money is owed.
       */
      if (cancelled.cancellationPenalty && cancelled.cancellationPenalty > 0) {
        const folios = await this.core.listFolios(cancelled.reservationId);
        await this.prisma.$transaction((tx) =>
          mirrorFolios(tx, mirrored.id, mirrored.currency, folios.folios),
        );
      }

      await this.finishLog(log.id, SyncStatus.SUCCESS, cancelled.reservationId);
      return mirrored;
    } catch (error) {
      await this.finishLog(log.id, SyncStatus.FAILED, reservation.operaReservationId, error);
      throw error;
    }
  }

  /**
   * Cancellation terms and deposit.
   *
   * The guest has to hear this before we cancel. Telling them after charging is
   * a settlement, not a notice. OPERA computes it — the rules hang off the rate,
   * and computing our own would diverge from what is actually charged.
   */
  async policies(id: string, user: AuthUser) {
    const { reservation, property } = await this.loadLinked(id, user);
    const result = await this.core.getReservationPolicies(
      reservation.operaReservationId!,
      property.operaHotelId,
    );
    // The screen calls back with the local id, so that is what we return.
    return { ...result, reservationId: reservation.id };
  }

  /** Guarantee change. It decides how a no-show is handled. */
  async setGuarantee(id: string, guaranteeCode: string, user: AuthUser): Promise<Reservation> {
    const { reservation, property } = await this.loadLinked(id, user);

    const log = await this.startLog('Reservation', reservation.operaReservationId, {
      action: 'set-guarantee',
      guaranteeCode,
    });

    try {
      const updated = await this.core.setGuarantee(
        reservation.operaReservationId!,
        guaranteeCode,
        property.operaHotelId,
      );
      const mirrored = await this.mirror(property, updated);
      await this.finishLog(log.id, SyncStatus.SUCCESS, updated.reservationId);
      return mirrored;
    } catch (error) {
      await this.finishLog(log.id, SyncStatus.FAILED, reservation.operaReservationId, error);
      throw error;
    }
  }

  /**
   * No-show.
   *
   * The same state transition as a cancel but different in accounting — a no-show
   * can be charged a fee and feeds next season's overbooking forecast. So it is
   * not folded into cancel. OPERA judges the arrival date and whether the guest is in.
   */
  async noShow(id: string, reason: string | undefined, user: AuthUser): Promise<Reservation> {
    const { reservation, property } = await this.loadLinked(id, user);

    const log = await this.startLog('Reservation', reservation.operaReservationId, {
      action: 'no-show',
      reason,
    });

    try {
      const result = await this.core.noShowReservation(reservation.operaReservationId!, reason);
      const mirrored = await this.mirror(property, result, reason);
      await this.finishLog(log.id, SyncStatus.SUCCESS, result.reservationId);
      return mirrored;
    } catch (error) {
      await this.finishLog(log.id, SyncStatus.FAILED, reservation.operaReservationId, error);
      throw error;
    }
  }

  // ---------------------------------------------------------------------------

  /**
   * Mirrors the OPERA result locally.
   *
   * Local values are a cache, so what OPERA returned is written verbatim. Taking
   * OPERA's confirmed values rather than ours is what keeps the two in step.
   */
  private async mirror(
    property: Property,
    source: CoreReservation,
    cancellationNote?: string,
  ): Promise<Reservation> {
    const roomType = await this.ensureRoomType(property.id, source.roomTypeCode);
    const ratePlan = source.ratePlanCode
      ? await this.ensureRatePlan(property.id, source.ratePlanCode)
      : null;
    const profile = await this.ensureProfile(source);

    const data = {
      propertyId: property.id,
      profileId: profile.id,
      roomTypeId: roomType.id,
      ratePlanId: ratePlan?.id ?? null,
      status: toReservationStatus(source.status),
      arrivalDate: parseDateOnly(source.arrivalDate),
      departureDate: parseDateOnly(source.departureDate),
      adults: source.adults ?? 1,
      children: source.children ?? 0,
      assignedRoomNumber: source.roomNumber ?? null,
      blockCode: source.blockCode ?? null,
      shareGroupId: source.shareGroupId ?? null,
      sourceCode: source.sourceCode ?? null,
      marketCode: source.marketCode ?? null,
      channelCode: source.channelCode ?? null,
      totalAmount: source.totalAmount === undefined ? null : new Prisma.Decimal(source.totalAmount),
      currency: source.currency ?? property.currency,
      guaranteeCode: source.guaranteeCode ?? null,
      cancellationPenalty:
        source.cancellationPenalty === undefined
          ? null
          : new Prisma.Decimal(source.cancellationPenalty),
      ...(cancellationNote ? { notes: cancellationNote } : {}),
    };

    return this.prisma.reservation.upsert({
      where: { operaReservationId: source.reservationId },
      update: data,
      create: {
        ...data,
        operaReservationId: source.reservationId,
        confirmationNumber: source.confirmationNumber ?? source.reservationId,
      },
    });
  }

  /**
   * Sends the OPERA profile id when the guest is already known.
   *
   * Without it OPERA creates a new profile every time. Each returning guest gains
   * another profile, stay history and preferences scatter across them, and someone
   * ends up merging by hand. Not creating is far cheaper than deleting.
   *
   * Email is the only clue. Names repeat too often to match on.
   */
  private async knownProfileId(email?: string): Promise<string | undefined> {
    if (!email) return undefined;

    const existing = await this.prisma.profile.findFirst({
      where: {
        email: { equals: email.trim(), mode: Prisma.QueryMode.insensitive },
        operaProfileId: { not: null },
        // Attaching a merged profile revives the duplicate just cleaned up.
        mergedIntoId: null,
      },
      select: { operaProfileId: true },
      orderBy: { updatedAt: 'desc' },
    });

    return existing?.operaProfileId ?? undefined;
  }

  /**
   * Waitlist confirmation.
   *
   * OPERA counts availability at the moment of confirming. Deciding ahead of it
   * misses the case where another waitlisted booking was confirmed in between.
   */
  async confirmWaitlist(id: string, user: AuthUser): Promise<Reservation> {
    const { reservation, property } = await this.loadLinked(id, user);

    if (reservation.status !== ReservationStatus.WAITLISTED) {
      throw new BadRequestException(`대기 상태가 아닙니다: ${reservation.status}`);
    }

    const log = await this.startLog('Reservation', reservation.operaReservationId, {
      action: 'confirmWaitlist',
    });

    try {
      const confirmed = await this.core.confirmWaitlist(
        reservation.operaReservationId!,
        property.operaHotelId,
      );
      const mirrored = await this.mirror(property, confirmed);
      await this.finishLog(log.id, SyncStatus.SUCCESS, confirmed.reservationId);
      return mirrored;
    } catch (error) {
      await this.finishLog(log.id, SyncStatus.FAILED, reservation.operaReservationId, error);
      throw error;
    }
  }

  /**
   * Room share.
   *
   * Two guests in one room settling separately. Whether the dates overlap, the
   * room types match and neither is already in another room is OPERA's call —
   * the side that knows inventory and room assignment has to decide.
   */
  async share(id: string, withReservationId: string, user: AuthUser): Promise<Reservation[]> {
    const { reservation, property } = await this.loadLinked(id, user);
    const { reservation: partner } = await this.loadLinked(withReservationId, user);

    // Different hotels cannot share a room. Blocked before the external call.
    if (partner.propertyId !== reservation.propertyId) {
      throw new BadRequestException('다른 호텔의 예약과는 객실을 함께 쓸 수 없습니다.');
    }

    const log = await this.startLog('Reservation', reservation.operaReservationId, {
      action: 'share',
      withReservationId: partner.operaReservationId,
    });

    try {
      const result = await this.core.shareReservation(reservation.operaReservationId!, {
        hotelId: property.operaHotelId,
        withReservationId: partner.operaReservationId!,
      });

      const mirrored = [];
      for (const source of result.reservations) {
        mirrored.push(await this.mirror(property, source));
      }
      await this.finishLog(log.id, SyncStatus.SUCCESS, reservation.operaReservationId);
      return mirrored;
    } catch (error) {
      await this.finishLog(log.id, SyncStatus.FAILED, reservation.operaReservationId, error);
      throw error;
    }
  }

  /** Unshare. Removes only this reservation from the group. */
  async unshare(id: string, user: AuthUser): Promise<Reservation> {
    const { reservation, property } = await this.loadLinked(id, user);

    if (!reservation.shareGroupId) {
      throw new BadRequestException('공유 중인 예약이 아닙니다.');
    }

    const log = await this.startLog('Reservation', reservation.operaReservationId, {
      action: 'unshare',
    });

    try {
      const updated = await this.core.unshareReservation(
        reservation.operaReservationId!,
        property.operaHotelId,
      );
      const mirrored = await this.mirror(property, updated);

      /*
       * Clears the flag on the partner left alone.
       *
       * OPERA already cleared it, but that reservation is not in this response.
       * Left in our copy, it would look shared when it is not.
       */
      const remaining = await this.prisma.reservation.findMany({
        where: { shareGroupId: reservation.shareGroupId },
        select: { id: true },
      });
      if (remaining.length === 1) {
        await this.prisma.reservation.update({
          where: { id: remaining[0]!.id },
          data: { shareGroupId: null },
        });
      }

      await this.finishLog(log.id, SyncStatus.SUCCESS, updated.reservationId);
      return mirrored;
    } catch (error) {
      await this.finishLog(log.id, SyncStatus.FAILED, reservation.operaReservationId, error);
      throw error;
    }
  }

  private async loadLinked(id: string, user: AuthUser) {
    const reservation = await this.prisma.reservation.findUnique({
      where: { id },
      include: { property: true },
    });
    if (!reservation) {
      throw new NotFoundException(`예약을 찾을 수 없습니다: ${id}`);
    }
    assertWithinScope(user, reservation.propertyId);

    // A reservation OPERA does not have cannot be fixed here; local-only diverges.
    if (!reservation.operaReservationId) {
      throw new BadRequestException(
        'OPERA 와 연결되지 않은 예약입니다. 먼저 동기화한 뒤 다시 시도해 주세요.',
      );
    }

    return { reservation, property: reservation.property };
  }

  private async resolveProperty(requested: string | undefined, user: AuthUser): Promise<Property> {
    const propertyId = resolvePropertyScope(user, requested);
    if (!propertyId) {
      throw new BadRequestException('호텔을 선택해 주세요.');
    }

    const property = await this.prisma.property.findUnique({ where: { id: propertyId } });
    if (!property) {
      throw new NotFoundException(`호텔을 찾을 수 없습니다: ${propertyId}`);
    }
    return property;
  }

  /**
   * Date range validation.
   *
   * OPERA rejects it too, but we stop it first — sending obviously wrong requests
   * out slows responses and burns OHIP rate limit.
   */
  private assertDateRange(arrival: string, departure: string): void {
    if (departure <= arrival) {
      throw new BadRequestException('출발일은 도착일보다 뒤여야 합니다.');
    }
  }

  private async ensureRoomType(propertyId: string, code?: string) {
    const roomTypeCode = code ?? 'UNKNOWN';
    return this.prisma.roomType.upsert({
      where: { propertyId_code: { propertyId, code: roomTypeCode } },
      update: {},
      create: { propertyId, code: roomTypeCode, name: roomTypeCode },
    });
  }

  private async ensureRatePlan(propertyId: string, code: string) {
    return this.prisma.ratePlan.upsert({
      where: { propertyId_code: { propertyId, code } },
      update: {},
      create: { propertyId, code, name: code },
    });
  }

  private async ensureProfile(source: CoreReservation) {
    const guest = source.guest;
    const operaProfileId = guest?.profileId;

    if (operaProfileId) {
      return this.prisma.profile.upsert({
        where: { operaProfileId },
        update: {
          firstName: guest?.firstName ?? undefined,
          lastName: guest?.lastName ?? undefined,
          email: guest?.email ?? undefined,
        },
        create: {
          operaProfileId,
          firstName: guest?.firstName ?? null,
          lastName: guest?.lastName ?? null,
          email: guest?.email ?? null,
        },
      });
    }

    if (guest?.email) {
      const byEmail = await this.prisma.profile.findFirst({ where: { email: guest.email } });
      if (byEmail) return byEmail;
    }

    return this.prisma.profile.create({
      data: {
        firstName: guest?.firstName ?? null,
        lastName: guest?.lastName ?? null,
        email: guest?.email ?? null,
      },
    });
  }

  /** Every write is logged. A failed OPERA call needs to show what we sent. */
  private startLog(entity: string, entityId: string | null, payload: unknown) {
    return startSyncLog(this.prisma, entity, entityId, payload);
  }

  private finishLog(
    id: string,
    status: SyncStatus,
    entityId: string | null,
    error?: unknown,
  ): Promise<void> {
    return finishSyncLog(this.prisma, id, status, {
      entityId,
      error,
      warn: (message) => this.logger.warn(`OPERA 쓰기 실패: ${message}`),
    });
  }
}
