import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ReservationStatus, RoomKeyStatus, type RoomKey } from '@prisma/client';
import type { AuthUser } from '../auth/auth.constants';
import { PrismaService } from '../prisma/prisma.service';
import { assertWithinScope } from '../properties/property-scope';
import { formatDateOnly } from '../sync/reservation.mapper';
import { DOOR_LOCK_DRIVER, DoorLockError, type DoorLockDriver } from './doorlock.driver';
import { zonedHourToUtc } from './local-time';
import type { IssueKeyDto, RevokeKeyDto } from './dto/doorlock.dto';

/** Check-out time; cards open until then. It belongs in hotel settings, fixed for now. */
const CHECKOUT_HOUR = 12;

/** How many hours before check-in cards start working. Early check-in slack. */
const EARLY_ACCESS_HOURS = 3;

/**
 * Room keys.
 *
 * The card data itself lives with the lock vendor. What happens here is **recording
 * what was issued to whom and when, and killing cards that must not open**.
 *
 * The most dangerous failure is a card left alive and forgotten — a departed guest's
 * card opens the room the next guest is in. So there is more machinery around
 * voiding than around issuing.
 */
@Injectable()
export class DoorLockService {
  private readonly logger = new Logger(DoorLockService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(DOOR_LOCK_DRIVER) private readonly driver: DoorLockDriver,
  ) {}

  /** Cards issued for this reservation. Used to pick which to kill on a loss report. */
  async listByReservation(reservationId: string, user: AuthUser) {
    const reservation = await this.loadReservation(reservationId, user);

    const keys = await this.prisma.roomKey.findMany({
      where: { reservationId },
      include: { issuedBy: { select: { name: true } } },
      orderBy: { issuedAt: 'desc' },
    });

    return {
      reservationId,
      roomNumber: reservation.assignedRoomNumber,
      /** In mock mode the screen has to say so. This key opens no door. */
      driverMode: this.driver.mode,
      items: keys.map(withExpiry),
    };
  }

  /**
   * Key issue.
   *
   * Requires an in-house reservation and an assigned room. A card given to a guest
   * who has not arrived opens the door of whoever is staying there now.
   */
  async issue(reservationId: string, dto: IssueKeyDto, user: AuthUser) {
    const reservation = await this.loadReservation(reservationId, user);

    if (reservation.status !== ReservationStatus.IN_HOUSE) {
      throw new BadRequestException(
        `재실 상태가 아닙니다(${reservation.status}). 체크인 후 발급할 수 있습니다.`,
      );
    }
    if (!reservation.assignedRoomNumber) {
      throw new BadRequestException('배정된 객실이 없습니다. 객실을 먼저 배정해 주세요.');
    }

    const timeZone = reservation.property.timezone;
    const validFrom = new Date(
      zonedHourToUtc(formatDateOnly(reservation.arrivalDate), CHECKOUT_HOUR, timeZone).getTime() -
        EARLY_ACCESS_HOURS * 3_600_000,
    );
    const validUntil = zonedHourToUtc(
      formatDateOnly(reservation.departureDate),
      CHECKOUT_HOUR,
      timeZone,
    );

    if (validUntil <= new Date()) {
      throw new BadRequestException(
        '이미 체크아웃 시각이 지났습니다. 체류를 연장한 뒤 발급해 주세요.',
      );
    }

    const previous = await this.prisma.roomKey.count({ where: { reservationId } });
    const sequence = previous + 1;

    /*
     * On a reissue the previous card is killed first.
     *
     * Reissuing after a loss is pointless if the old card is still alive — the lost
     * card keeps opening the door.
     */
    if (dto.replaceExisting !== false) {
      await this.revokeActive(reservationId, '재발급');
    }

    let vendorKeyId: string;
    try {
      const result = await this.driver.encode({
        propertyCode: reservation.property.operaHotelId,
        roomNumber: reservation.assignedRoomNumber,
        validFrom,
        validUntil,
        sequence,
      });
      vendorKeyId = result.vendorKeyId;
    } catch (error) {
      const rejected = error instanceof DoorLockError && error.rejected;
      this.logger.error(`카드 발급 실패 (${rejected ? '거절' : '결과 불명'}): ${describe(error)}`);
      throw new BadRequestException(
        rejected
          ? `잠금장치가 발급을 거절했습니다: ${describe(error)}`
          : '잠금장치에 연결하지 못했습니다. 카드가 만들어졌을 수 있으니 인코더를 확인해 주세요.',
      );
    }

    const key = await this.prisma.roomKey.create({
      data: {
        propertyId: reservation.propertyId,
        reservationId,
        roomNumber: reservation.assignedRoomNumber,
        vendorKeyId,
        validFrom,
        validUntil,
        sequence,
        issuedById: user.id,
      },
    });

    return withExpiry(key);
  }

  async revoke(keyId: string, dto: RevokeKeyDto, user: AuthUser) {
    const key = await this.prisma.roomKey.findUnique({ where: { id: keyId } });
    if (!key) {
      throw new NotFoundException(`키를 찾을 수 없습니다: ${keyId}`);
    }
    assertWithinScope(user, key.propertyId);

    if (key.status !== RoomKeyStatus.ACTIVE) {
      // Killing an already dead card returns success. It has to be idempotent.
      return withExpiry(key);
    }

    await this.revokeOne(key, dto.reason ?? '수동 무효화');
    const updated = await this.prisma.roomKey.findUniqueOrThrow({ where: { id: keyId } });
    return withExpiry(updated);
  }

  /**
   * Kills every live card for this reservation.
   *
   * Called by check-out and room change. Missed, a departed guest's card opens the
   * next guest's room — the most dangerous failure in this domain.
   */
  async revokeActive(reservationId: string, reason: string): Promise<number> {
    const active = await this.prisma.roomKey.findMany({
      where: { reservationId, status: RoomKeyStatus.ACTIVE },
    });

    let revoked = 0;
    for (const key of active) {
      await this.revokeOne(key, reason);
      revoked += 1;
    }
    return revoked;
  }

  // ---------------------------------------------------------------------------

  /**
   * The vendor kills it first, then the local row is marked.
   *
   * The order matters. Changed locally first, a failed vendor call leaves a card
   * "recorded as dead but actually opening", and nobody knows.
   */
  private async revokeOne(key: RoomKey, reason: string): Promise<void> {
    try {
      await this.driver.revoke(key.vendorKeyId);
    } catch (error) {
      this.logger.error(`카드 무효화 실패: ${key.vendorKeyId} — ${describe(error)}`);
      throw new BadRequestException(
        '잠금장치에서 카드를 무효화하지 못했습니다. 카드가 아직 열릴 수 있으니 확인해 주세요.',
      );
    }

    await this.prisma.roomKey.update({
      where: { id: key.id },
      data: { status: RoomKeyStatus.REVOKED, revokedAt: new Date(), revokedReason: reason },
    });
  }

  private async loadReservation(reservationId: string, user: AuthUser) {
    const reservation = await this.prisma.reservation.findUnique({
      where: { id: reservationId },
      include: { property: true },
    });
    if (!reservation) {
      throw new NotFoundException(`예약을 찾을 수 없습니다: ${reservationId}`);
    }
    assertWithinScope(user, reservation.propertyId);
    return reservation;
  }
}

/**
 * Expiry is computed on read rather than stored.
 *
 * Refreshing status by batch makes the screen lie while the batch is behind. The
 * lock checks validity itself, so only the display needs to agree here.
 */
function withExpiry(key: RoomKey & { issuedBy?: { name: string } | null }) {
  const expired = key.status === RoomKeyStatus.ACTIVE && key.validUntil <= new Date();
  return {
    ...key,
    status: expired ? RoomKeyStatus.EXPIRED : key.status,
    issuedByName: key.issuedBy?.name ?? null,
  };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export type RoomKeyView = ReturnType<typeof withExpiry>;
