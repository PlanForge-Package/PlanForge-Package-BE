import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ReservationStatus, RoomKeyStatus, type RoomKey } from '@prisma/client';
import type { AuthUser } from '../auth/auth.constants';
import { PrismaService } from '../prisma/prisma.service';
import { assertWithinScope } from '../properties/property-scope';
import { formatDateOnly } from '../sync/reservation.mapper';
import { DOOR_LOCK_DRIVER, DoorLockError, type DoorLockDriver } from './doorlock.driver';
import { zonedHourToUtc } from './local-time';
import type { IssueKeyDto, RevokeKeyDto } from './dto/doorlock.dto';

/** 체크아웃 시각. 이 시각까지 카드가 열린다. 호텔 설정으로 뺄 값이지만 지금은 고정한다. */
const CHECKOUT_HOUR = 12;

/** 체크인 전 몇 시간부터 카드가 열리는지. 얼리 체크인 여유. */
const EARLY_ACCESS_HOURS = 3;

/**
 * 객실 키.
 *
 * 실제 카드 데이터는 잠금장치 벤더가 들고 있다. 여기서 하는 일은 **언제 누구에게
 * 무엇을 발급했는지 남기고, 열려 있으면 안 되는 카드를 죽이는 것**이다.
 *
 * 가장 위험한 실패는 카드가 살아 있는 채로 잊히는 것이다 — 체크아웃한 손님의
 * 카드가 다음 손님이 들어온 방을 연다. 그래서 발급보다 무효화 쪽에 더 많은
 * 장치를 둔다.
 */
@Injectable()
export class DoorLockService {
  private readonly logger = new Logger(DoorLockService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(DOOR_LOCK_DRIVER) private readonly driver: DoorLockDriver,
  ) {}

  /** 이 예약에 발급된 카드 이력. 분실 신고 때 어느 카드를 죽일지 고른다. */
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
      /** 모의 모드면 화면이 그 사실을 알려야 한다. 이 키로는 문이 열리지 않는다. */
      driverMode: this.driver.mode,
      items: keys.map(withExpiry),
    };
  }

  /**
   * 키 발급.
   *
   * 재실 예약과 배정된 객실이 있어야 한다. 아직 들어오지 않은 손님에게 카드를
   * 주면 그 방에 지금 묵고 있는 사람의 문이 열린다.
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
     * 재발급이면 이전 카드를 먼저 죽인다.
     *
     * 분실 재발급인데 이전 카드가 살아 있으면 재발급의 의미가 없다. 잃어버린
     * 카드로 계속 문이 열린다.
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
      // 이미 죽은 카드를 다시 죽이라는 요청은 성공으로 둔다. 멱등해야 한다.
      return withExpiry(key);
    }

    await this.revokeOne(key, dto.reason ?? '수동 무효화');
    const updated = await this.prisma.roomKey.findUniqueOrThrow({ where: { id: keyId } });
    return withExpiry(updated);
  }

  /**
   * 이 예약의 살아 있는 카드를 전부 죽인다.
   *
   * 체크아웃과 객실 변경이 부른다. 이걸 빠뜨리면 나간 손님의 카드가 다음 손님의
   * 방을 연다 — 이 도메인에서 가장 위험한 실패다.
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
   * 벤더에서 먼저 죽이고 로컬을 표시한다.
   *
   * 순서가 중요하다. 로컬만 먼저 바꾸면 벤더 호출이 실패했을 때 "죽었다고
   * 적혀 있지만 실제로는 열리는 카드" 가 남고, 아무도 그 사실을 모른다.
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
 * 만료는 저장하지 않고 볼 때 계산한다.
 *
 * 상태를 배치로 갱신하면 배치가 밀린 동안 화면이 거짓말을 한다. 잠금장치는
 * 어차피 유효 기간을 스스로 보므로, 여기서는 표시만 맞추면 된다.
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
