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
  SyncDirection,
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
import type {
  CreateRoomOutageDto,
  ListRoomOutagesDto,
  ReleaseRoomOutageDto,
} from './dto/room-outages.dto';

const OUTAGE_INCLUDE = {
  room: { select: { id: true, number: true, floor: true, roomType: { select: { code: true } } } },
  createdBy: { select: { id: true, name: true } },
} satisfies Prisma.RoomOutageInclude;

/** 아직 오지 않았거나 진행 중인 예약. 나간 손님의 방은 막아도 된다. */
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

/** 사용 불가 구분에 대응하는 하우스키핑 상태. */
const KIND_TO_ROOM_STATUS: Record<RoomOutageKind, RoomStatus> = {
  [RoomOutageKind.OUT_OF_ORDER]: RoomStatus.OUT_OF_ORDER,
  [RoomOutageKind.OUT_OF_SERVICE]: RoomStatus.OUT_OF_SERVICE,
};

/**
 * 사용 불가 객실.
 *
 * 객실을 며칠 팔지 않겠다는 결정은 재고 그 자체라 OPERA 가 원천이다. 여기서
 * 로컬에만 기록하면 OPERA 로 들어온 예약이 공사 중인 객실에 배정된다.
 *
 * 그래서 등록·해제는 모두 Core 를 거쳐 OPERA 에 먼저 반영하고, 돌아온 결과만
 * 로컬에 옮겨 적는다. 우리가 보낸 값이 아니라 저쪽이 확정한 값이 기준이다.
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
      // 해제된 건은 기본적으로 감춘다. 지금 무엇을 못 파는지가 알고 싶은 것이다.
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
   * 객실을 사용 불가로 등록한다.
   *
   * OPERA 도 거절하는 조건이지만 여기서 먼저 본다 — 우리 쪽에서 확실히 틀린
   * 요청까지 외부 호출을 태울 이유가 없고, 배정 확인은 OPERA 보다 BE 가
   * 더 잘 안다(객실 배정을 BE 가 들고 있다).
   */
  async create(dto: CreateRoomOutageDto, user: AuthUser): Promise<RoomOutage> {
    const property = await this.resolveProperty(dto.propertyId, user);

    if (dto.endDate < dto.startDate) {
      throw new BadRequestException(
        `종료일(${dto.endDate})이 시작일(${dto.startDate})보다 앞설 수 없습니다.`,
      );
    }

    // 이미 지난 기간을 막아도 그 사이 판 객실이 되돌아오지 않는다. 실적만 어긋난다.
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

    // 같은 객실을 두 번 빼면 재고에서 두 번 깎인다.
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
     * 그 기간에 이 객실로 들어오기로 한 손님이 있으면 먼저 옮겨야 한다.
     *
     * 출발일은 그날 낮에 비므로 재고를 차지하는 마지막 밤은 출발일 전날이다.
     * 그래서 arrivalDate <= endDate 와 departureDate > startDate 로 본다.
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

    // 오늘 당장 빼는데 손님이 들어 있으면 막는다. 미래 기간은 그때까지 나간다.
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

    // OPERA 가 확정한 값을 그대로 옮겨 적는다.
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

      // 기간이 오늘을 포함할 때만 지금 상태를 바꾼다. 다음 주 공사 때문에
      // 오늘 못 파는 것은 아니다.
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
   * 사용 불가 해제.
   *
   * 복귀 상태는 등록할 때 정해 둔 값(대개 DIRTY)을 쓴다. CLEAN 으로 되돌리면
   * 청소하지 않은 객실이 판매 가능으로 보인다.
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

  private startLog(roomNumber: string, payload: unknown) {
    return this.prisma.syncLog.create({
      data: {
        entity: 'RoomOutage',
        entityId: roomNumber,
        direction: SyncDirection.PUSH,
        status: SyncStatus.PENDING,
        payload: payload as Prisma.InputJsonValue,
      },
    });
  }

  private async finishLog(id: string, status: SyncStatus, error?: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : error ? String(error) : null;
    await this.prisma.syncLog.update({
      where: { id },
      data: { status, finishedAt: new Date(), ...(message ? { error: message } : {}) },
    });
  }
}

/** OPERA 표기의 복귀 상태. 매핑은 하우스키핑과 같은 규칙을 쓴다. */
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

function toDateString(value: Date): string {
  return value.toISOString().slice(0, 10);
}

/** 오늘(UTC). @db.Date 컬럼과 같은 기준을 쓴다. */
function todayString(): string {
  return new Date().toISOString().slice(0, 10);
}
