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
   * Room status change.
   *
   * Room status is the hotel's record, so OPERA owns it. The front desk's inventory
   * view and housekeeping's cleaning state must be the same value; held separately
   * in PlanForge, the two disagree on whether a room can be checked into.
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

    // OPERA rejects it too, but we stop it first — an obviously wrong request is not worth a call.
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

      // The value OPERA confirmed is copied over. Their value is the reference, not ours.
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
   * Housekeeping staff available for assignment.
   *
   * The account list (`/users`) is admin-only. A manager assigning work needs
   * candidates, but that is no reason to open every account. Only this hotel's
   * active housekeeping staff are returned, with the minimum needed to assign.
   */
  async listAttendants(propertyIdInput: string | undefined, user: AuthUser) {
    const property = await this.resolveProperty(propertyIdInput, user);

    const items = await this.prisma.user.findMany({
      where: {
        role: UserRole.HOUSEKEEPING,
        active: true,
        // Head-office staff (propertyId=null) can be deployed to any hotel.
        OR: [{ propertyId: property.id }, { propertyId: null }],
      },
      select: { id: true, name: true, role: true },
      orderBy: { name: 'asc' },
    });

    return { propertyId: property.id, items };
  }

  /**
   * Tasks for a working day.
   *
   * The housekeeping role sees only its own tasks. There is no reason to look at
   * someone else's, and a full list makes finding your own harder.
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
   * Creates the day's tasks.
   *
   * Covers rooms needing cleaning (DIRTY) and occupied rooms. Existing tasks are
   * left alone, so pressing again never resets the assignments.
   */
  async generateTasks(dto: GenerateTasksDto, user: AuthUser) {
    const property = await this.resolveProperty(dto.propertyId, user);
    const dateString = dto.date ?? today();
    const date = parseDateOnly(dateString);

    const rooms = await this.prisma.room.findMany({
      where: {
        propertyId: property.id,
        // Rooms out of sale are not cleaning targets. Maintenance comes first.
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

  /** Task assignment. An empty value unassigns it. */
  async assignTask(taskId: string, dto: AssignTaskDto, user: AuthUser) {
    const task = await this.loadTask(taskId, user);

    if (dto.assignedToId) {
      const assignee = await this.prisma.user.findUnique({ where: { id: dto.assignedToId } });
      if (!assignee || !assignee.active) {
        throw new BadRequestException('배정할 수 없는 계정입니다.');
      }
      // Assigned to another hotel's staff, that person never sees the task on their screen.
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
   * Task progress change.
   *
   * The housekeeping role can change only its own tasks. Completing someone else's
   * puts a room that was never cleaned back on sale.
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
   * Finds rooms whose status and actual occupancy disagree.
   *
   * When OPERA's room status and the reservation's in-house flag split, the front
   * desk sells a room it cannot sell, or misses an empty one it thinks is occupied.
   * Housekeeping checks this daily, so it is pulled out separately.
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

    // The return type is explicit; without it each branch narrows kind and they never merge.
    const items: Discrepancy[] = rooms.flatMap((room): Discrepancy[] => {
      const reservation = occupiedByReservation.get(room.number) ?? null;

      // Marked occupied with no in-house reservation — a check-out was likely missed.
      if (room.occupied && !reservation) {
        return [{ room, kind: 'OCCUPIED_WITHOUT_RESERVATION', reservation: null }];
      }
      // An in-house reservation with an empty room — assignment likely went wrong at check-in.
      if (!room.occupied && reservation) {
        return [{ room, kind: 'RESERVATION_WITHOUT_OCCUPANCY', reservation }];
      }
      // Occupied but marked clean — the cleaning status was likely raised in error.
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

/** Today in UTC, the same basis as @db.Date columns. */
function today(): string {
  return new Date().toISOString().slice(0, 10);
}
