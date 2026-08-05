import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  Prisma,
  ReservationStatus,
  RoomOutageKind,
  RoomStatus,
  SyncStatus,
  type Property,
  type RoomOutage,
} from '@prisma/client';
import type { AuthUser } from '../auth/auth.constants';
import { CoreClient } from '../core/core.client';
import type { CoreRoomOutage } from '../core/core.types';
import { PrismaService } from '../prisma/prisma.service';
import { assertWithinScope, resolvePropertyScope } from '../properties/property-scope';
import { parseDateOnly } from '../sync/reservation.mapper';
import { finishSyncLog, startSyncLog } from '../sync/sync-log';
import { toDateString, todayString } from '../common/date';
import type {
  CreateRoomOutageDto,
  ListRoomOutagesDto,
  ReleaseRoomOutageDto,
} from './dto/room-outages.dto';

const OUTAGE_INCLUDE = {
  room: { select: { id: true, number: true, floor: true, roomType: { select: { code: true } } } },
  createdBy: { select: { id: true, name: true } },
} satisfies Prisma.RoomOutageInclude;

/** Reservations not yet over. A departed guest's room may be taken out. */
const LIVE_RESERVATION = [
  ReservationStatus.RESERVED,
  ReservationStatus.CONFIRMED,
  ReservationStatus.IN_HOUSE,
];

const TO_OPERA_KIND: Record<RoomOutageKind, 'OutOfOrder' | 'OutOfService'> = {
  [RoomOutageKind.OUT_OF_ORDER]: 'OutOfOrder',
  [RoomOutageKind.OUT_OF_SERVICE]: 'OutOfService',
};

const FROM_OPERA_KIND: Record<string, RoomOutageKind> = {
  OutOfOrder: RoomOutageKind.OUT_OF_ORDER,
  OutOfService: RoomOutageKind.OUT_OF_SERVICE,
};

/** Housekeeping status matching each outage kind. */
const KIND_TO_ROOM_STATUS: Record<RoomOutageKind, RoomStatus> = {
  [RoomOutageKind.OUT_OF_ORDER]: RoomStatus.OUT_OF_ORDER,
  [RoomOutageKind.OUT_OF_SERVICE]: RoomStatus.OUT_OF_SERVICE,
};

/**
 * Room outages.
 *
 * Deciding not to sell a room for some days is inventory itself, so OPERA owns it.
 * Recorded locally only, a booking that reached OPERA lands in a room under work.
 *
 * So registering and releasing both go through Core to OPERA first, and only the
 * result is copied locally. Their confirmed value is the reference, not ours.
 */
@Injectable()
export class RoomOutagesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly core: CoreClient,
  ) {}

  async list(query: ListRoomOutagesDto, user: AuthUser) {
    const propertyId = resolvePropertyScope(user, query.propertyId);
    const onDate = query.onDate ? parseDateOnly(query.onDate) : undefined;

    const where: Prisma.RoomOutageWhereInput = {
      ...(propertyId ? { propertyId } : {}),
      ...(query.roomNumber ? { room: { number: query.roomNumber } } : {}),
      // Released outages are hidden by default. The question is what cannot be sold now.
      ...(query.includeReleased === 'true' ? {} : { releasedAt: null }),
      ...(onDate ? { startDate: { lte: onDate }, endDate: { gte: onDate } } : {}),
    };

    const items = await this.prisma.roomOutage.findMany({
      where,
      include: OUTAGE_INCLUDE,
      orderBy: [{ startDate: 'asc' }, { room: { number: 'asc' } }],
    });

    return { items, total: items.length };
  }

  /**
   * Takes a room out of service.
   *
   * OPERA rejects these conditions too, but we check first — there is no reason to
   * spend a call on a request we know is wrong, and BE knows assignments better
   * than OPERA does, since BE holds room assignment.
   */
  async create(dto: CreateRoomOutageDto, user: AuthUser): Promise<RoomOutage> {
    const property = await this.resolveProperty(dto.propertyId, user);

    if (dto.endDate < dto.startDate) {
      throw new BadRequestException(
        `종료일(${dto.endDate})이 시작일(${dto.startDate})보다 앞설 수 없습니다.`,
      );
    }

    // Blocking a past range does not bring back rooms already sold. It only skews reports.
    const today = todayString();
    if (dto.endDate < today) {
      throw new BadRequestException(
        `이미 지난 기간(${dto.startDate} ~ ${dto.endDate})은 사용 불가로 등록할 수 없습니다.`,
      );
    }

    const room = await this.prisma.room.findUnique({
      where: { propertyId_number: { propertyId: property.id, number: dto.roomNumber } },
    });
    if (!room) {
      throw new NotFoundException(`객실을 찾을 수 없습니다: ${dto.roomNumber}`);
    }

    const startDate = parseDateOnly(dto.startDate);
    const endDate = parseDateOnly(dto.endDate);

    // Taking one room out twice deducts it from inventory twice.
    const overlapping = await this.prisma.roomOutage.findFirst({
      where: {
        roomId: room.id,
        releasedAt: null,
        startDate: { lte: endDate },
        endDate: { gte: startDate },
      },
    });
    if (overlapping) {
      throw new ConflictException(
        `객실 ${room.number} 는 ${toDateString(overlapping.startDate)} ~ ${toDateString(overlapping.endDate)} 기간에 이미 사용 불가입니다.`,
      );
    }

    /*
     * Guests already booked into this room during the range have to be moved first.
     *
     * The departure day frees up in the morning, so the last night held is the day
     * before. Hence arrivalDate <= endDate and departureDate > startDate.
     */
    const assigned = await this.prisma.reservation.findFirst({
      where: {
        propertyId: property.id,
        assignedRoomNumber: room.number,
        status: { in: LIVE_RESERVATION },
        arrivalDate: { lte: endDate },
        departureDate: { gt: startDate },
      },
      select: { confirmationNumber: true, id: true },
    });
    if (assigned) {
      throw new ConflictException(
        `해당 기간에 예약 ${assigned.confirmationNumber ?? assigned.id} 가 객실 ${room.number} 에 배정되어 있습니다. 객실을 먼저 변경해 주세요.`,
      );
    }

    // Blocked if a guest is in the room today. A future range clears by then.
    if (room.occupied && dto.startDate <= today) {
      throw new ConflictException(
        `객실 ${room.number} 는 재실 중이라 지금부터 사용 불가로 둘 수 없습니다.`,
      );
    }

    const returnStatus = dto.returnStatus ?? RoomStatus.DIRTY;
    const log = await this.startLog(room.number, {
      action: 'createRoomOutage',
      kind: dto.kind,
      startDate: dto.startDate,
      endDate: dto.endDate,
    });

    let result: CoreRoomOutage;
    try {
      result = await this.core.createRoomOutage({
        hotelId: property.operaHotelId,
        roomNumber: room.number,
        kind: TO_OPERA_KIND[dto.kind],
        startDate: dto.startDate,
        endDate: dto.endDate,
        reason: dto.reason,
        returnStatus: toOperaRoomStatusName(returnStatus),
      });
      await this.finishLog(log.id, SyncStatus.SUCCESS);
    } catch (error) {
      await this.finishLog(log.id, SyncStatus.FAILED, error);
      throw error;
    }

    // The value OPERA confirmed is copied over as is.
    const covered = coversDate(result.startDate, result.endDate, today);

    return this.prisma.$transaction(async (tx) => {
      const saved = await tx.roomOutage.create({
        data: {
          propertyId: property.id,
          roomId: room.id,
          operaId: result.outageId,
          kind: FROM_OPERA_KIND[result.kind] ?? dto.kind,
          startDate: parseDateOnly(result.startDate),
          endDate: parseDateOnly(result.endDate),
          reason: result.reason || dto.reason,
          returnStatus,
          createdById: user.id,
        },
        include: OUTAGE_INCLUDE,
      });

      // The current status changes only when the range covers today. Work next week
      // does not make the room unsellable now.
      if (covered) {
        await tx.room.update({
          where: { id: room.id },
          data: { status: KIND_TO_ROOM_STATUS[saved.kind] },
        });
      }

      return saved;
    });
  }

  /**
   * Releases an outage.
   *
   * The return status is the one chosen at registration, usually DIRTY. Returning
   * to CLEAN would put an uncleaned room back on sale.
   */
  async release(id: string, dto: ReleaseRoomOutageDto, user: AuthUser): Promise<RoomOutage> {
    const outage = await this.prisma.roomOutage.findUnique({
      where: { id },
      include: { property: true, room: true },
    });
    if (!outage) {
      throw new NotFoundException(`사용 불가 기록을 찾을 수 없습니다: ${id}`);
    }
    assertWithinScope(user, outage.propertyId);

    if (outage.releasedAt) {
      throw new ConflictException('이미 해제된 기록입니다.');
    }

    const log = await this.startLog(outage.room.number, {
      action: 'releaseRoomOutage',
      operaId: outage.operaId,
    });

    try {
      await this.core.releaseRoomOutage(outage.operaId, {
        hotelId: outage.property.operaHotelId,
        reason: dto.reason,
      });
      await this.finishLog(log.id, SyncStatus.SUCCESS);
    } catch (error) {
      await this.finishLog(log.id, SyncStatus.FAILED, error);
      throw error;
    }

    const today = todayString();
    const covered = coversDate(toDateString(outage.startDate), toDateString(outage.endDate), today);

    return this.prisma.$transaction(async (tx) => {
      const saved = await tx.roomOutage.update({
        where: { id },
        data: { releasedAt: new Date() },
        include: OUTAGE_INCLUDE,
      });

      if (covered) {
        await tx.room.update({
          where: { id: outage.roomId },
          data: { status: outage.returnStatus },
        });
      }

      return saved;
    });
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

  private startLog(roomNumber: string | null, payload: unknown) {
    return startSyncLog(this.prisma, 'RoomOutage', roomNumber, payload);
  }

  private finishLog(id: string, status: SyncStatus, error?: unknown): Promise<void> {
    return finishSyncLog(this.prisma, id, status, { error });
  }
}

/** Return status in OPERA's terms. The mapping follows the housekeeping rules. */
function toOperaRoomStatusName(status: RoomStatus): string {
  const names: Record<RoomStatus, string> = {
    [RoomStatus.CLEAN]: 'Clean',
    [RoomStatus.DIRTY]: 'Dirty',
    [RoomStatus.INSPECTED]: 'Inspected',
    [RoomStatus.OUT_OF_ORDER]: 'OutOfOrder',
    [RoomStatus.OUT_OF_SERVICE]: 'OutOfService',
  };
  return names[status];
}

function coversDate(startDate: string, endDate: string, date: string): boolean {
  return startDate <= date && endDate >= date;
}

/** Today in UTC, the same basis as @db.Date columns. */
