import { Injectable } from '@nestjs/common';
import { FolioStatus, Prisma, ReservationStatus, type Property } from '@prisma/client';
import type { AuthUser } from '../auth/auth.constants';
import { CoreClient } from '../core/core.client';
import { HousekeepingService } from '../housekeeping/housekeeping.service';
import { PrismaService } from '../prisma/prisma.service';
import { resolvePropertyScope } from '../properties/property-scope';
import { BookingService } from '../reservations/booking.service';
import { formatDateOnly, parseDateOnly } from '../sync/reservation.mapper';
import { badRequest, notFound } from '../common/errors';

/** Kinds of item that block the close, so the screen can act on each differently. */
export type AuditItemKind =
  | 'ARRIVAL_PENDING'
  | 'DEPARTURE_PENDING'
  | 'IN_HOUSE_UNASSIGNED'
  | 'OPEN_BALANCE'
  | 'ROOM_DISCREPANCY';

/**
 * Night audit.
 *
 * OPERA runs the close itself — rolling the business date and auto-posting room and
 * tax is the PMS's job, and imitating it would split the revenue between the two
 * systems. What happens here is showing what would be left wrong by closing now.
 *
 * Skipping this check leaves no-shows in house eating the next day's inventory,
 * folios with balances closed so revenue leaks, and in-house reservations with no room.
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

    // OPERA owns the business date. Out of reach, the calendar date stands in and the
    // screen is told so — a close decision must never be made silently on the wrong date.
    let businessDate = new Date().toISOString().slice(0, 10);
    let businessDateFromOpera = false;
    try {
      const result = await this.core.getBusinessDate(property.operaHotelId);
      businessDate = result.businessDate;
      businessDateFromOpera = true;
    } catch {
      // Reported below as businessDateFromOpera=false.
    }

    const day = parseDateOnly(businessDate);

    const [arrivals, departures, unassigned, openFolios, discrepancies] = await Promise.all([
      // Due to arrive but not in yet — a no-show candidate.
      this.prisma.reservation.findMany({
        where: {
          propertyId: property.id,
          arrivalDate: { lte: day },
          status: { in: [ReservationStatus.RESERVED, ReservationStatus.CONFIRMED] },
        },
        include: { profile: true, roomType: true },
        orderBy: { arrivalDate: 'asc' },
      }),
      // Due to depart but still in house — a missed check-out.
      this.prisma.reservation.findMany({
        where: {
          propertyId: property.id,
          departureDate: { lte: day },
          status: ReservationStatus.IN_HOUSE,
        },
        include: { profile: true, roomType: true },
        orderBy: { departureDate: 'asc' },
      }),
      // In house with no room — missing from cleaning assignment and untraceable.
      this.prisma.reservation.findMany({
        where: {
          propertyId: property.id,
          status: ReservationStatus.IN_HOUSE,
          assignedRoomNumber: null,
        },
        include: { profile: true, roomType: true },
      }),
      // Open folios with a balance — closing as is leaks revenue.
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
      /** No items left means closing is safe. The close itself runs in OPERA. */
      ready: outstanding === 0,
      sections,
    };
  }

  /**
   * No-show.
   *
   * OPERA judges whether the arrival date has passed and whether the guest is
   * already in. Checking here as well would split the rules across two places.
   */
  async markNoShow(reservationId: string, reason: string | undefined, user: AuthUser) {
    if (!reservationId) {
      throw badRequest('RESERVATION_TARGET_REQUIRED');
    }
    return this.booking.noShow(reservationId, reason, user);
  }

  private async resolveProperty(requested: string | undefined, user: AuthUser): Promise<Property> {
    const propertyId = resolvePropertyScope(user, requested);
    if (!propertyId) {
      throw badRequest('PROPERTY_REQUIRED');
    }

    const property = await this.prisma.property.findUnique({ where: { id: propertyId } });
    if (!property) {
      throw notFound('PROPERTY_NOT_FOUND', { propertyId: propertyId });
    }
    return property;
  }
}

function guestName(profile: { lastName: string | null; firstName: string | null }): string {
  return [profile.lastName, profile.firstName].filter(Boolean).join(' ') || '(이름 없음)';
}
