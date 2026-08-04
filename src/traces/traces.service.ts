import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, TraceStatus, type ReservationTrace } from '@prisma/client';
import type { AuthUser } from '../auth/auth.constants';
import { PrismaService } from '../prisma/prisma.service';
import { assertWithinScope, resolvePropertyScope } from '../properties/property-scope';
import { parseDateOnly } from '../sync/reservation.mapper';
import type { CreateTraceDto, ListTracesDto } from './dto/traces.dto';

const TRACE_INCLUDE = {
  reservation: {
    select: {
      id: true,
      confirmationNumber: true,
      assignedRoomNumber: true,
      arrivalDate: true,
      departureDate: true,
      profile: { select: { lastName: true, firstName: true } },
    },
  },
  createdBy: { select: { id: true, name: true } },
  completedBy: { select: { id: true, name: true } },
} satisfies Prisma.ReservationTraceInclude;

/**
 * Trace — a departmental instruction attached to a reservation.
 *
 * "07:00 on arrival, housekeeping — crib": work a given department must do on a
 * given date. Written in the reservation notes, nobody reads it unless that
 * department opens the reservation. Grouping by date and department delivers it.
 *
 * These are our own staff scheduling and do not go to OPERA — same reason as
 * housekeeping assignment.
 */
@Injectable()
export class TracesService {
  constructor(private readonly prisma: PrismaService) {}

  /** Grouped by date and department. The list a department opens in the morning. */
  async list(query: ListTracesDto, user: AuthUser) {
    const propertyId = resolvePropertyScope(user, query.propertyId);
    const date = parseDateOnly(query.date ?? today());

    const items = await this.prisma.reservationTrace.findMany({
      where: {
        ...(propertyId ? { propertyId } : {}),
        dueDate: date,
        ...(query.department ? { department: query.department } : {}),
        ...(query.status ? { status: query.status } : {}),
      },
      include: TRACE_INCLUDE,
      orderBy: [{ status: 'asc' }, { department: 'asc' }, { createdAt: 'asc' }],
    });

    return { date: query.date ?? today(), items, total: items.length };
  }

  /** Every instruction on a reservation, past ones too — what was done is the history. */
  async listByReservation(reservationId: string, user: AuthUser) {
    await this.loadReservation(reservationId, user);

    const items = await this.prisma.reservationTrace.findMany({
      where: { reservationId },
      include: TRACE_INCLUDE,
      orderBy: [{ dueDate: 'asc' }, { createdAt: 'asc' }],
    });

    return { items, total: items.length };
  }

  async create(
    reservationId: string,
    dto: CreateTraceDto,
    user: AuthUser,
  ): Promise<ReservationTrace> {
    const reservation = await this.loadReservation(reservationId, user);

    /*
     * An instruction after the departure date is seen by nobody.
     *
     * Dated after the guest leaves, it shows on that department's list for the day
     * but the subject is gone. Pre-arrival prep is valid, so earlier is allowed.
     */
    const dueDate = parseDateOnly(dto.dueDate);
    if (dueDate > reservation.departureDate) {
      throw new BadRequestException(
        `출발일(${toDateString(reservation.departureDate)}) 이후 날짜에는 지시를 걸 수 없습니다.`,
      );
    }

    return this.prisma.reservationTrace.create({
      data: {
        propertyId: reservation.propertyId,
        reservationId,
        department: dto.department,
        dueDate,
        note: dto.note.trim(),
        createdById: user.id,
      },
      include: TRACE_INCLUDE,
    });
  }

  /** Completion. Who did it is recorded — otherwise undone work turns into questions. */
  async complete(id: string, user: AuthUser): Promise<ReservationTrace> {
    const trace = await this.prisma.reservationTrace.findUnique({ where: { id } });
    if (!trace) {
      throw new NotFoundException(`지시를 찾을 수 없습니다: ${id}`);
    }
    assertWithinScope(user, trace.propertyId);

    if (trace.status === TraceStatus.DONE) {
      throw new ConflictException('이미 처리된 지시입니다.');
    }

    return this.prisma.reservationTrace.update({
      where: { id },
      data: { status: TraceStatus.DONE, completedById: user.id, completedAt: new Date() },
      include: TRACE_INCLUDE,
    });
  }

  /**
   * Instruction delete.
   *
   * A completed instruction is never deleted — what was done is the history, and
   * deleting it becomes indistinguishable from "not done". Only mistakes are withdrawn.
   */
  async remove(id: string, user: AuthUser) {
    const trace = await this.prisma.reservationTrace.findUnique({ where: { id } });
    if (!trace) {
      throw new NotFoundException(`지시를 찾을 수 없습니다: ${id}`);
    }
    assertWithinScope(user, trace.propertyId);

    if (trace.status === TraceStatus.DONE) {
      throw new ConflictException('처리된 지시는 지울 수 없습니다.');
    }

    await this.prisma.reservationTrace.delete({ where: { id } });
    return { removed: true, id };
  }

  private async loadReservation(reservationId: string, user: AuthUser) {
    const reservation = await this.prisma.reservation.findUnique({
      where: { id: reservationId },
      select: { id: true, propertyId: true, departureDate: true },
    });
    if (!reservation) {
      throw new NotFoundException(`예약을 찾을 수 없습니다: ${reservationId}`);
    }
    assertWithinScope(user, reservation.propertyId);
    return reservation;
  }
}

function toDateString(value: Date): string {
  return value.toISOString().slice(0, 10);
}

/** Today in UTC, the same basis as @db.Date columns. */
function today(): string {
  return new Date().toISOString().slice(0, 10);
}
