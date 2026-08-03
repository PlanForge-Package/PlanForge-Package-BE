import { Injectable, Logger } from '@nestjs/common';
import { Prisma, SyncDirection, SyncStatus } from '@prisma/client';
import { CoreClient } from '../core/core.client';
import type { CoreReservation } from '../core/core.types';
import { PrismaService } from '../prisma/prisma.service';
import { parseDateOnly, toReservationStatus } from './reservation.mapper';

export interface SyncReservationsInput {
  hotelId: string;
  arrivalDate?: string;
  departureDate?: string;
  /** Core 를 페이지 단위로 훑을 때의 페이지 크기. */
  pageSize?: number;
  /** 안전장치. 이 페이지 수를 넘으면 중단하고 로그에 남긴다. */
  maxPages?: number;
}

export interface SyncReservationsResult {
  hotelId: string;
  fetched: number;
  created: number;
  updated: number;
  failed: number;
  truncated: boolean;
}

/** Core 가 객실 타입을 주지 않은 예약에 임시로 붙이는 코드. */
const UNKNOWN_ROOM_TYPE_CODE = 'UNKNOWN';

@Injectable()
export class SyncService {
  private readonly logger = new Logger(SyncService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly core: CoreClient,
  ) {}

  /**
   * Core 를 통해 OPERA 예약을 끌어와 로컬 DB 에 반영한다.
   *
   * 예약 한 건의 실패가 배치 전체를 멈추지 않도록 건별로 격리하고, 실패는
   * SyncLog 에 남겨 나중에 재시도할 수 있게 한다.
   */
  async syncReservations(input: SyncReservationsInput): Promise<SyncReservationsResult> {
    const { hotelId, arrivalDate, departureDate, pageSize = 100, maxPages = 50 } = input;

    const batchLog = await this.prisma.syncLog.create({
      data: {
        entity: 'Reservation',
        direction: SyncDirection.PULL,
        status: SyncStatus.PENDING,
        payload: { hotelId, arrivalDate, departureDate } as Prisma.InputJsonValue,
      },
    });

    const result: SyncReservationsResult = {
      hotelId,
      fetched: 0,
      created: 0,
      updated: 0,
      failed: 0,
      truncated: false,
    };

    try {
      const property = await this.ensureProperty(hotelId);

      for (let page = 0; page < maxPages; page += 1) {
        const batch = await this.core.listReservations({
          hotelId,
          arrivalDate,
          departureDate,
          limit: pageSize,
          offset: page * pageSize,
        });

        const items = batch.items ?? [];
        result.fetched += items.length;

        for (const reservation of items) {
          try {
            const outcome = await this.upsertReservation(property.id, reservation);
            if (outcome === 'created') result.created += 1;
            else result.updated += 1;
          } catch (error) {
            result.failed += 1;
            await this.logFailure(reservation, error);
          }
        }

        if (items.length < pageSize) break;

        if (page === maxPages - 1) {
          result.truncated = true;
          this.logger.warn(
            `예약 동기화가 최대 페이지(${maxPages})에 도달해 중단했습니다. hotelId=${hotelId}`,
          );
        }
      }

      await this.prisma.syncLog.update({
        where: { id: batchLog.id },
        data: {
          status: result.failed > 0 ? SyncStatus.FAILED : SyncStatus.SUCCESS,
          finishedAt: new Date(),
          payload: { ...result } as Prisma.InputJsonValue,
          error: result.failed > 0 ? `${result.failed}건 실패` : null,
        },
      });

      return result;
    } catch (error) {
      await this.prisma.syncLog.update({
        where: { id: batchLog.id },
        data: {
          status: SyncStatus.FAILED,
          finishedAt: new Date(),
          error: error instanceof Error ? error.message : String(error),
        },
      });
      throw error;
    }
  }

  /** 호텔 코드에 해당하는 Property 가 없으면 최소 정보로 만든다. */
  private async ensureProperty(operaHotelId: string) {
    return this.prisma.property.upsert({
      where: { operaHotelId },
      update: {},
      create: { operaHotelId, name: operaHotelId },
    });
  }

  private async upsertReservation(
    propertyId: string,
    source: CoreReservation,
  ): Promise<'created' | 'updated'> {
    const roomType = await this.ensureRoomType(propertyId, source.roomTypeCode);
    const ratePlan = source.ratePlanCode
      ? await this.ensureRatePlan(propertyId, source.ratePlanCode)
      : null;
    const profile = await this.ensureProfile(source);

    const data = {
      propertyId,
      profileId: profile.id,
      roomTypeId: roomType.id,
      ratePlanId: ratePlan?.id ?? null,
      status: toReservationStatus(source.status),
      arrivalDate: parseDateOnly(source.arrivalDate),
      departureDate: parseDateOnly(source.departureDate),
      adults: source.adults ?? 1,
      children: source.children ?? 0,
      assignedRoomNumber: source.roomNumber ?? null,
    };

    const existing = await this.prisma.reservation.findUnique({
      where: { operaReservationId: source.reservationId },
      select: { id: true },
    });

    if (existing) {
      await this.prisma.reservation.update({ where: { id: existing.id }, data });
      return 'updated';
    }

    await this.prisma.reservation.create({
      data: {
        ...data,
        operaReservationId: source.reservationId,
        confirmationNumber: source.confirmationNumber ?? source.reservationId,
      },
    });
    return 'created';
  }

  private async ensureRoomType(propertyId: string, code?: string) {
    const roomTypeCode = code ?? UNKNOWN_ROOM_TYPE_CODE;
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

  /**
   * OPERA profileId 로 먼저 찾고, 없으면 이메일로 기존 프로필을 재사용한다.
   * 둘 다 없으면 새로 만든다 — 예약 동기화가 프로필 부재로 실패하지 않게 한다.
   */
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

  private async logFailure(reservation: CoreReservation, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    this.logger.warn(`예약 동기화 실패 reservationId=${reservation.reservationId}: ${message}`);

    await this.prisma.syncLog.create({
      data: {
        entity: 'Reservation',
        entityId: reservation.reservationId,
        direction: SyncDirection.PULL,
        status: SyncStatus.FAILED,
        error: message,
        finishedAt: new Date(),
        payload: { ...reservation } as Prisma.InputJsonValue,
      },
    });
  }
}
