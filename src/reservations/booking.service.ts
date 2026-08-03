import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma, SyncDirection, SyncStatus, type Property, type Reservation } from '@prisma/client';
import type { AuthUser } from '../auth/auth.constants';
import { CoreClient } from '../core/core.client';
import type { CoreReservation } from '../core/core.types';
import { PrismaService } from '../prisma/prisma.service';
import { assertWithinScope, resolvePropertyScope } from '../properties/property-scope';
import { parseDateOnly, toReservationStatus } from '../sync/reservation.mapper';
import type {
  CancelBookingDto,
  CheckAvailabilityDto,
  CreateBookingDto,
  UpdateBookingDto,
} from './dto/booking.dto';

/**
 * 예약 생성·수정·취소.
 *
 * OPERA 가 기록의 원천이다. 재고 판단·요금 계산·확인 번호 발급을 여기서 하지
 * 않고 Core 를 통해 OPERA 에 맡긴 뒤, 돌아온 결과를 로컬에 미러링한다.
 *
 * 두 시스템이 각자 계산하면 언젠가 값이 갈리고, 회계 데이터에서 그건 어느 쪽이
 * 맞는지 판단할 근거가 없다는 뜻이다. 그래서 로컬 레코드는 캐시로 다룬다.
 */
@Injectable()
export class BookingService {
  private readonly logger = new Logger(BookingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly core: CoreClient,
  ) {}

  /** 가용 재고. 계산하지 않고 OPERA 에 묻는다. */
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

  /** 기간 요금. 마찬가지로 OPERA 가 정한다. */
  async getRates(dto: CheckAvailabilityDto, user: AuthUser) {
    const property = await this.resolveProperty(dto.propertyId, user);
    this.assertDateRange(dto.arrivalDate, dto.departureDate);

    const result = await this.core.getRates({
      hotelId: property.operaHotelId,
      arrivalDate: dto.arrivalDate,
      departureDate: dto.departureDate,
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
        guest: dto.guest,
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
      await this.finishLog(log.id, SyncStatus.SUCCESS, cancelled.reservationId);
      return mirrored;
    } catch (error) {
      await this.finishLog(log.id, SyncStatus.FAILED, reservation.operaReservationId, error);
      throw error;
    }
  }

  // ---------------------------------------------------------------------------

  /**
   * OPERA 결과를 로컬에 반영한다.
   *
   * 로컬 값은 캐시이므로 OPERA 가 준 것을 그대로 덮어쓴다. 우리가 보낸 값이
   * 아니라 OPERA 가 확정한 값을 기준으로 삼아야 두 쪽이 갈리지 않는다.
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
      totalAmount: source.totalAmount === undefined ? null : new Prisma.Decimal(source.totalAmount),
      currency: source.currency ?? property.currency,
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

  private async loadLinked(id: string, user: AuthUser) {
    const reservation = await this.prisma.reservation.findUnique({
      where: { id },
      include: { property: true },
    });
    if (!reservation) {
      throw new NotFoundException(`예약을 찾을 수 없습니다: ${id}`);
    }
    assertWithinScope(user, reservation.propertyId);

    // OPERA 에 없는 예약은 여기서 고칠 수 없다. 로컬만 바꾸면 두 쪽이 갈린다.
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
   * 날짜 범위 검증.
   *
   * OPERA 도 거절하지만 여기서 먼저 막는다 — 명백히 틀린 요청까지 외부 호출을
   * 태우면 응답이 느려지고 OHIP 레이트리밋을 낭비한다.
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

  /** 쓰기는 전부 이력을 남긴다. OPERA 호출이 실패했을 때 무엇을 보냈는지 알아야 한다. */
  private startLog(entity: string, entityId: string | null, payload: unknown) {
    return this.prisma.syncLog.create({
      data: {
        entity,
        entityId,
        direction: SyncDirection.PUSH,
        status: SyncStatus.PENDING,
        payload: payload as Prisma.InputJsonValue,
      },
    });
  }

  private async finishLog(
    id: string,
    status: SyncStatus,
    entityId: string | null,
    error?: unknown,
  ): Promise<void> {
    const message = error instanceof Error ? error.message : error ? String(error) : null;
    if (message) {
      this.logger.warn(`OPERA 쓰기 실패: ${message}`);
    }

    await this.prisma.syncLog.update({
      where: { id },
      data: {
        status,
        finishedAt: new Date(),
        ...(entityId ? { entityId } : {}),
        ...(message ? { error: message } : {}),
      },
    });
  }
}
