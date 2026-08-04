import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  Prisma,
  ReservationStatus,
  SyncDirection,
  SyncStatus,
  type Property,
  type Reservation,
} from '@prisma/client';
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
      // 1인당 붙는 패키지가 있다. 인원을 빼면 안내 금액과 청구가 갈린다.
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
      await this.finishLog(log.id, SyncStatus.SUCCESS, cancelled.reservationId);
      return mirrored;
    } catch (error) {
      await this.finishLog(log.id, SyncStatus.FAILED, reservation.operaReservationId, error);
      throw error;
    }
  }

  /**
   * 노쇼 처리.
   *
   * 취소와 같은 상태 전이지만 회계상 의미가 다르다 — 노쇼는 수수료를 청구할 수
   * 있고 다음 시즌 오버부킹 예측에도 쓰인다. 그래서 취소로 뭉뚱그리지 않는다.
   * 도착일이 지났는지, 이미 들어온 손님은 아닌지는 OPERA 가 판단한다.
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
      shareGroupId: source.shareGroupId ?? null,
      sourceCode: source.sourceCode ?? null,
      marketCode: source.marketCode ?? null,
      channelCode: source.channelCode ?? null,
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

  /**
   * 이미 아는 손님이면 그 OPERA 프로필 ID 를 함께 보낸다.
   *
   * 보내지 않으면 OPERA 가 매번 새 프로필을 만든다. 재방문 손님마다 프로필이
   * 하나씩 늘어나고, 투숙 이력과 선호가 여러 프로필로 흩어져 결국 사람이 손으로
   * 병합해야 한다. 만들지 않는 편이 지우는 것보다 훨씬 싸다.
   *
   * 이메일이 유일한 단서다. 이름은 동명이인이 흔해 근거로 쓸 수 없다.
   */
  private async knownProfileId(email?: string): Promise<string | undefined> {
    if (!email) return undefined;

    const existing = await this.prisma.profile.findFirst({
      where: {
        email: { equals: email.trim(), mode: Prisma.QueryMode.insensitive },
        operaProfileId: { not: null },
        // 병합된 프로필로 붙이면 방금 정리한 중복이 되살아난다.
        mergedIntoId: null,
      },
      select: { operaProfileId: true },
      orderBy: { updatedAt: 'desc' },
    });

    return existing?.operaProfileId ?? undefined;
  }

  /**
   * 대기 확정.
   *
   * 자리가 났는지는 확정하는 순간 OPERA 가 세어 본다. 우리가 미리 판단하면 그
   * 사이 다른 대기 건이 먼저 확정된 경우를 놓친다.
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
   * 객실 공유.
   *
   * 두 손님이 한 방을 쓰되 계산은 따로 하는 편성이다. 겹치는 기간·같은 객실
   * 타입인지, 이미 다른 방에 들어가 있지는 않은지는 OPERA 가 본다 — 재고와
   * 객실 배정을 아는 쪽이 판단해야 한다.
   */
  async share(id: string, withReservationId: string, user: AuthUser): Promise<Reservation[]> {
    const { reservation, property } = await this.loadLinked(id, user);
    const { reservation: partner } = await this.loadLinked(withReservationId, user);

    // 호텔이 다르면 같은 방을 쓸 수 없다. 외부 호출 전에 막는다.
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

  /** 공유 해제. 이 예약만 묶음에서 뺀다. */
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
       * 혼자 남은 상대의 표시도 푼다.
       *
       * OPERA 는 이미 풀었지만 그 예약은 이번 응답에 실려 오지 않는다. 사본에
       * 남겨 두면 공유가 아닌데 공유로 보인다.
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
