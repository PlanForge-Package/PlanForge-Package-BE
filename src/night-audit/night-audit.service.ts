import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { FolioStatus, Prisma, ReservationStatus, type Property } from '@prisma/client';
import type { AuthUser } from '../auth/auth.constants';
import { CoreClient } from '../core/core.client';
import { HousekeepingService } from '../housekeeping/housekeeping.service';
import { PrismaService } from '../prisma/prisma.service';
import { resolvePropertyScope } from '../properties/property-scope';
import { BookingService } from '../reservations/booking.service';
import { formatDateOnly, parseDateOnly } from '../sync/reservation.mapper';

/** 마감을 막는 항목의 종류. 화면이 항목마다 다른 처리를 붙일 수 있어야 한다. */
export type AuditItemKind =
  | 'ARRIVAL_PENDING'
  | 'DEPARTURE_PENDING'
  | 'IN_HOUSE_UNASSIGNED'
  | 'OPEN_BALANCE'
  | 'ROOM_DISCREPANCY';

/**
 * 야간 감사.
 *
 * 마감 자체는 OPERA 가 돌린다 — 영업일을 넘기고 룸·세금을 자동 포스팅하는 것은
 * PMS 의 일이고, 우리가 흉내 내면 두 시스템의 매출이 갈린다. 여기서 하는 일은
 * "지금 마감하면 무엇이 잘못 남는가" 를 미리 보여 주는 것이다.
 *
 * 실무에서 이 점검을 놓치면 노쇼가 재실로 남아 다음 날 재고를 먹고, 잔액이 남은
 * 폴리오가 마감되어 매출이 새고, 배정되지 않은 재실 예약이 청소 대상에서 빠진다.
 */
@Injectable()
export class NightAuditService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly core: CoreClient,
    private readonly booking: BookingService,
    private readonly housekeeping: HousekeepingService,
  ) {}

  async review(requestedPropertyId: string | undefined, user: AuthUser) {
    const property = await this.resolveProperty(requestedPropertyId, user);

    // 영업일은 OPERA 가 원천이다. 닿지 않으면 달력 날짜로 대신하되 그 사실을
    // 화면에 알린다 — 마감 판단을 잘못된 날짜로 조용히 내리면 안 된다.
    let businessDate = new Date().toISOString().slice(0, 10);
    let businessDateFromOpera = false;
    try {
      const result = await this.core.getBusinessDate(property.operaHotelId);
      businessDate = result.businessDate;
      businessDateFromOpera = true;
    } catch {
      // 아래에서 businessDateFromOpera=false 로 알린다.
    }

    const day = parseDateOnly(businessDate);

    const [arrivals, departures, unassigned, openFolios, discrepancies] = await Promise.all([
      // 도착 예정인데 아직 안 들어온 예약 — 노쇼 후보.
      this.prisma.reservation.findMany({
        where: {
          propertyId: property.id,
          arrivalDate: { lte: day },
          status: { in: [ReservationStatus.RESERVED, ReservationStatus.CONFIRMED] },
        },
        include: { profile: true, roomType: true },
        orderBy: { arrivalDate: 'asc' },
      }),
      // 출발 예정인데 아직 나가지 않은 재실 — 체크아웃 누락.
      this.prisma.reservation.findMany({
        where: {
          propertyId: property.id,
          departureDate: { lte: day },
          status: ReservationStatus.IN_HOUSE,
        },
        include: { profile: true, roomType: true },
        orderBy: { departureDate: 'asc' },
      }),
      // 재실인데 객실이 없다 — 청소 배정에서도 빠지고 위치도 알 수 없다.
      this.prisma.reservation.findMany({
        where: {
          propertyId: property.id,
          status: ReservationStatus.IN_HOUSE,
          assignedRoomNumber: null,
        },
        include: { profile: true, roomType: true },
      }),
      // 잔액이 남은 열린 폴리오 — 이대로 마감하면 매출이 샌다.
      this.prisma.folio.findMany({
        where: {
          status: FolioStatus.OPEN,
          balance: { not: new Prisma.Decimal(0) },
          reservation: { propertyId: property.id },
        },
        include: { reservation: { include: { profile: true } } },
      }),
      this.housekeeping.findDiscrepancies(property.id, user),
    ]);

    const sections = [
      {
        kind: 'ARRIVAL_PENDING' as const,
        label: '도착 예정인데 아직 오지 않음',
        hint: '노쇼로 처리하거나 체크인해야 합니다. 그대로 두면 다음 날 재고를 계속 먹습니다.',
        items: arrivals.map((r) => ({
          reservationId: r.id,
          confirmationNumber: r.confirmationNumber,
          guest: guestName(r.profile),
          date: formatDateOnly(r.arrivalDate),
          roomTypeCode: r.roomType.code,
          roomNumber: r.assignedRoomNumber,
          amount: null as string | null,
        })),
      },
      {
        kind: 'DEPARTURE_PENDING' as const,
        label: '출발 예정인데 아직 나가지 않음',
        hint: '체크아웃하거나 체류를 연장해야 합니다.',
        items: departures.map((r) => ({
          reservationId: r.id,
          confirmationNumber: r.confirmationNumber,
          guest: guestName(r.profile),
          date: formatDateOnly(r.departureDate),
          roomTypeCode: r.roomType.code,
          roomNumber: r.assignedRoomNumber,
          amount: null as string | null,
        })),
      },
      {
        kind: 'IN_HOUSE_UNASSIGNED' as const,
        label: '재실인데 객실이 배정되지 않음',
        hint: '객실을 배정해야 청소 대상에 잡히고 위치를 알 수 있습니다.',
        items: unassigned.map((r) => ({
          reservationId: r.id,
          confirmationNumber: r.confirmationNumber,
          guest: guestName(r.profile),
          date: formatDateOnly(r.arrivalDate),
          roomTypeCode: r.roomType.code,
          roomNumber: null,
          amount: null as string | null,
        })),
      },
      {
        kind: 'OPEN_BALANCE' as const,
        label: '잔액이 남은 폴리오',
        hint: '결제하거나 조정해야 합니다. 이대로 마감하면 매출이 샙니다.',
        items: openFolios.map((folio) => ({
          reservationId: folio.reservationId,
          confirmationNumber: folio.reservation.confirmationNumber,
          guest: guestName(folio.reservation.profile),
          date: formatDateOnly(folio.reservation.departureDate),
          roomTypeCode: null,
          roomNumber: folio.reservation.assignedRoomNumber,
          amount: folio.balance.toString(),
        })),
      },
      {
        kind: 'ROOM_DISCREPANCY' as const,
        label: '객실 상태와 재실이 어긋남',
        hint: '하우스키핑 화면에서 확인해야 합니다.',
        items: discrepancies.items.map((item) => ({
          reservationId: null,
          confirmationNumber: item.reservation,
          guest: null,
          date: null,
          roomTypeCode: item.room.roomType.code,
          roomNumber: item.room.number,
          amount: null as string | null,
        })),
      },
    ];

    const outstanding = sections.reduce((sum, section) => sum + section.items.length, 0);

    return {
      propertyId: property.id,
      businessDate,
      businessDateFromOpera,
      calendarDate: new Date().toISOString().slice(0, 10),
      outstanding,
      /** 남은 항목이 없으면 마감해도 안전하다는 뜻이다. 마감은 OPERA 에서 돌린다. */
      ready: outstanding === 0,
      sections,
    };
  }

  /**
   * 노쇼 처리.
   *
   * 도착일이 지났는지·이미 들어온 손님은 아닌지는 OPERA 가 판단한다. 여기서
   * 따로 검사하면 두 곳의 규칙이 갈라진다.
   */
  async markNoShow(reservationId: string, reason: string | undefined, user: AuthUser) {
    if (!reservationId) {
      throw new BadRequestException('대상 예약을 지정해 주세요.');
    }
    return this.booking.noShow(reservationId, reason, user);
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
}

function guestName(profile: { lastName: string | null; firstName: string | null }): string {
  return [profile.lastName, profile.firstName].filter(Boolean).join(' ') || '(이름 없음)';
}
