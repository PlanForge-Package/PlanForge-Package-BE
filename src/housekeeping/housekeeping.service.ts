import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import {
  Prisma,
  RoomStatus,
  SyncDirection,
  SyncStatus,
  TaskStatus,
  UserRole,
  type Property,
} from '@prisma/client';
import type { AuthUser } from '../auth/auth.constants';
import { CoreClient } from '../core/core.client';
import { PrismaService } from '../prisma/prisma.service';
import { assertWithinScope, resolvePropertyScope } from '../properties/property-scope';
import { parseDateOnly } from '../sync/reservation.mapper';
import type {
  AssignTaskDto,
  GenerateTasksDto,
  ListTasksDto,
  UpdateRoomStatusDto,
  UpdateTaskDto,
} from './dto/housekeeping.dto';
import { fromOperaRoomStatus, toOperaRoomStatus } from './room-status.mapper';

const TASK_INCLUDE = {
  room: { include: { roomType: true } },
  assignedTo: { select: { id: true, name: true, role: true } },
} satisfies Prisma.HousekeepingTaskInclude;

@Injectable()
export class HousekeepingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly core: CoreClient,
  ) {}

  /**
   * 객실 상태 변경.
   *
   * 객실 상태는 호텔의 기록이므로 OPERA 가 원천이다. 프론트데스크의 재고 판단과
   * 하우스키핑의 청소 상태가 같은 값을 봐야 하는데, PlanForge 가 따로 들고 있으면
   * 체크인 가능 여부가 두 시스템에서 달라진다.
   */
  async updateRoomStatus(roomId: string, dto: UpdateRoomStatusDto, user: AuthUser) {
    const room = await this.prisma.room.findUnique({
      where: { id: roomId },
      include: { property: true },
    });
    if (!room) {
      throw new NotFoundException(`객실을 찾을 수 없습니다: ${roomId}`);
    }
    assertWithinScope(user, room.propertyId);

    // OPERA 도 거절하지만 여기서 먼저 막는다 — 명백히 틀린 요청까지 외부 호출을 태울 이유가 없다.
    const blocking =
      dto.status === RoomStatus.OUT_OF_ORDER || dto.status === RoomStatus.OUT_OF_SERVICE;
    if (room.occupied && blocking) {
      throw new BadRequestException('재실 중인 객실은 판매 불가 상태로 변경할 수 없습니다.');
    }

    const log = await this.startLog(room.number, { action: 'roomStatus', status: dto.status });

    try {
      const result = await this.core.updateRoomStatus(room.number, {
        hotelId: room.property.operaHotelId,
        status: toOperaRoomStatus(dto.status),
        reason: dto.reason,
      });

      // OPERA 가 확정한 값을 그대로 반영한다. 우리가 보낸 값이 아니라 저쪽이 기준이다.
      const updated = await this.prisma.room.update({
        where: { id: roomId },
        data: {
          status: fromOperaRoomStatus(result.status),
          ...(result.occupied === undefined ? {} : { occupied: result.occupied }),
        },
        include: { roomType: true },
      });

      await this.finishLog(log.id, SyncStatus.SUCCESS);
      return updated;
    } catch (error) {
      await this.finishLog(log.id, SyncStatus.FAILED, error);
      throw error;
    }
  }

  /**
   * 배정 가능한 하우스키핑 직원.
   *
   * 계정 목록(`/users`)은 ADMIN 전용이다. 매니저가 배정하려면 담당자 후보가
   * 필요한데, 그렇다고 전체 계정을 열어 줄 이유는 없다. 이 호텔의 활성
   * 하우스키핑 직원만, 배정에 필요한 최소 정보만 돌려준다.
   */
  async listAttendants(propertyIdInput: string | undefined, user: AuthUser) {
    const property = await this.resolveProperty(propertyIdInput, user);

    const items = await this.prisma.user.findMany({
      where: {
        role: UserRole.HOUSEKEEPING,
        active: true,
        // 본사 소속(propertyId=null)은 어느 호텔에나 투입할 수 있다.
        OR: [{ propertyId: property.id }, { propertyId: null }],
      },
      select: { id: true, name: true, role: true },
      orderBy: { name: 'asc' },
    });

    return { propertyId: property.id, items };
  }

  /**
   * 근무일의 작업 목록.
   *
   * 하우스키핑 역할은 자기 작업만 본다. 남의 배정을 들여다볼 이유가 없고,
   * 화면에 전체가 뜨면 자기 몫을 찾기 어렵다.
   */
  async listTasks(query: ListTasksDto, user: AuthUser) {
    const propertyId = resolvePropertyScope(user, query.propertyId);
    const date = parseDateOnly(query.date ?? today());

    const assignedToId =
      user.role === UserRole.HOUSEKEEPING
        ? user.id
        : query.assignedToId === 'me'
          ? user.id
          : query.assignedToId;

    const where: Prisma.HousekeepingTaskWhereInput = {
      ...(propertyId ? { propertyId } : {}),
      date,
      ...(query.status ? { status: query.status } : {}),
      ...(query.unassignedOnly ? { assignedToId: null } : assignedToId ? { assignedToId } : {}),
    };

    const items = await this.prisma.housekeepingTask.findMany({
      where,
      include: TASK_INCLUDE,
      orderBy: [{ status: 'asc' }, { room: { number: 'asc' } }],
    });

    return { date: query.date ?? today(), items, total: items.length };
  }

  /**
   * 근무일 작업을 만든다.
   *
   * 청소가 필요한 객실(DIRTY)과 재실 객실을 대상으로 한다. 이미 만들어진 작업은
   * 건드리지 않아 여러 번 눌러도 배정이 초기화되지 않는다.
   */
  async generateTasks(dto: GenerateTasksDto, user: AuthUser) {
    const property = await this.resolveProperty(dto.propertyId, user);
    const dateString = dto.date ?? today();
    const date = parseDateOnly(dateString);

    const rooms = await this.prisma.room.findMany({
      where: {
        propertyId: property.id,
        // 판매 불가 객실은 청소 대상이 아니다. 정비가 먼저다.
        status: { in: [RoomStatus.DIRTY, RoomStatus.CLEAN, RoomStatus.INSPECTED] },
        OR: [{ status: RoomStatus.DIRTY }, { occupied: true }],
      },
      select: { id: true },
    });

    const existing = await this.prisma.housekeepingTask.findMany({
      where: { propertyId: property.id, date },
      select: { roomId: true },
    });
    const known = new Set(existing.map((task) => task.roomId));

    const created = rooms.filter((room) => !known.has(room.id));
    if (created.length > 0) {
      await this.prisma.housekeepingTask.createMany({
        data: created.map((room) => ({ propertyId: property.id, roomId: room.id, date })),
        skipDuplicates: true,
      });
    }

    return { date: dateString, created: created.length, existing: known.size };
  }

  /** 작업 배정. 빈 값이면 배정을 해제한다. */
  async assignTask(taskId: string, dto: AssignTaskDto, user: AuthUser) {
    const task = await this.loadTask(taskId, user);

    if (dto.assignedToId) {
      const assignee = await this.prisma.user.findUnique({ where: { id: dto.assignedToId } });
      if (!assignee || !assignee.active) {
        throw new BadRequestException('배정할 수 없는 계정입니다.');
      }
      // 다른 호텔 직원에게 배정하면 그 직원은 자기 화면에서 이 작업을 볼 수 없다.
      if (assignee.propertyId && assignee.propertyId !== task.propertyId) {
        throw new BadRequestException('다른 호텔 소속 직원에게는 배정할 수 없습니다.');
      }
    }

    return this.prisma.housekeepingTask.update({
      where: { id: taskId },
      data: { assignedToId: dto.assignedToId || null },
      include: TASK_INCLUDE,
    });
  }

  /**
   * 작업 진행 상태 변경.
   *
   * 하우스키핑 역할은 자기 작업만 바꿀 수 있다. 남의 작업을 완료 처리하면
   * 실제로는 청소되지 않은 객실이 판매 가능으로 올라간다.
   */
  async updateTask(taskId: string, dto: UpdateTaskDto, user: AuthUser) {
    const task = await this.loadTask(taskId, user);

    if (user.role === UserRole.HOUSEKEEPING && task.assignedToId !== user.id) {
      throw new BadRequestException('본인에게 배정된 작업만 변경할 수 있습니다.');
    }

    const now = new Date();
    return this.prisma.housekeepingTask.update({
      where: { id: taskId },
      data: {
        status: dto.status,
        ...(dto.notes === undefined ? {} : { notes: dto.notes }),
        ...(dto.status === TaskStatus.IN_PROGRESS && !task.startedAt ? { startedAt: now } : {}),
        ...(dto.status === TaskStatus.DONE || dto.status === TaskStatus.INSPECTED
          ? { completedAt: now }
          : {}),
      },
      include: TASK_INCLUDE,
    });
  }

  /**
   * 객실 상태와 실제 재실이 어긋난 곳을 찾는다.
   *
   * OPERA 의 객실 상태와 예약의 재실 여부가 갈리면 프론트데스크가 팔 수 없는
   * 방을 팔거나, 비어 있는 방을 재실로 보고 놓친다. 하우스키핑이 매일 확인하는
   * 항목이라 별도로 뽑아 준다.
   */
  async findDiscrepancies(propertyIdInput: string | undefined, user: AuthUser) {
    const property = await this.resolveProperty(propertyIdInput, user);

    const rooms = await this.prisma.room.findMany({
      where: { propertyId: property.id },
      include: { roomType: true },
      orderBy: { number: 'asc' },
    });

    const inHouse = await this.prisma.reservation.findMany({
      where: { propertyId: property.id, status: 'IN_HOUSE', assignedRoomNumber: { not: null } },
      select: { assignedRoomNumber: true, confirmationNumber: true },
    });
    const occupiedByReservation = new Map(
      inHouse.map((r) => [r.assignedRoomNumber as string, r.confirmationNumber]),
    );

    type Room = (typeof rooms)[number];
    type Discrepancy = {
      room: Room;
      kind: 'OCCUPIED_WITHOUT_RESERVATION' | 'RESERVATION_WITHOUT_OCCUPANCY' | 'OCCUPIED_BUT_CLEAN';
      reservation: string | null;
    };

    // 반환 타입을 명시한다. 없으면 분기마다 kind 리터럴이 좁혀져 합쳐지지 않는다.
    const items: Discrepancy[] = rooms.flatMap((room): Discrepancy[] => {
      const reservation = occupiedByReservation.get(room.number) ?? null;

      // 재실 표시인데 재실 예약이 없다 — 체크아웃 처리가 누락됐을 가능성.
      if (room.occupied && !reservation) {
        return [{ room, kind: 'OCCUPIED_WITHOUT_RESERVATION', reservation: null }];
      }
      // 재실 예약이 있는데 객실은 비어 있다 — 체크인 시 배정이 어긋났을 가능성.
      if (!room.occupied && reservation) {
        return [{ room, kind: 'RESERVATION_WITHOUT_OCCUPANCY', reservation }];
      }
      // 재실인데 청소 완료로 표시 — 청소 상태가 잘못 올라갔을 가능성.
      if (room.occupied && room.status === RoomStatus.CLEAN) {
        return [{ room, kind: 'OCCUPIED_BUT_CLEAN', reservation }];
      }
      return [];
    });

    return { propertyId: property.id, total: items.length, items };
  }

  // ---------------------------------------------------------------------------

  private async loadTask(taskId: string, user: AuthUser) {
    const task = await this.prisma.housekeepingTask.findUnique({ where: { id: taskId } });
    if (!task) {
      throw new NotFoundException(`작업을 찾을 수 없습니다: ${taskId}`);
    }
    assertWithinScope(user, task.propertyId);
    return task;
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
        entity: 'Room',
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

/** 오늘(UTC). @db.Date 컬럼과 같은 기준을 쓴다. */
function today(): string {
  return new Date().toISOString().slice(0, 10);
}
