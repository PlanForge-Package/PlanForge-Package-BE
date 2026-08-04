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
 * 트레이스 — 예약에 붙는 부서별 지시.
 *
 * "도착일 07:00 하우스키핑 — 유아용 침대" 처럼 특정 날짜에 특정 부서가 해야 할
 * 일이다. 예약 메모에 적어 두면 그 부서가 예약을 열어 보지 않는 한 아무도
 * 읽지 않는다. 날짜와 부서로 모아 볼 수 있어야 지시가 실제로 전달된다.
 *
 * 이 지시는 우리 직원의 근무 편성이라 OPERA 에 보내지 않는다 — 하우스키핑
 * 배정과 같은 이유다.
 */
@Injectable()
export class TracesService {
  constructor(private readonly prisma: PrismaService) {}

  /** 날짜·부서로 모아 본다. 부서 화면이 아침에 여는 목록이다. */
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

  /** 한 예약에 걸린 지시 전부. 지난 것도 함께 본다 — 무엇을 했는지가 이력이다. */
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
     * 출발일보다 뒤인 지시는 아무도 보지 않는다.
     *
     * 손님이 나간 뒤의 날짜로 잡으면 그 부서의 그날 목록에는 뜨지만 대상이
     * 이미 없다. 도착 전 준비는 있을 수 있으므로 앞쪽은 막지 않는다.
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

  /** 처리 완료. 누가 했는지 남긴다 — 안 된 일을 두고 서로 묻게 되기 때문이다. */
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
   * 지시 삭제.
   *
   * 처리된 지시는 지우지 않는다 — 무엇을 했는지가 이력이고, 지우면 "안 했다"
   * 와 구분되지 않는다. 잘못 건 지시만 거둔다.
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

/** 오늘(UTC). @db.Date 컬럼과 같은 기준을 쓴다. */
function today(): string {
  return new Date().toISOString().slice(0, 10);
}
