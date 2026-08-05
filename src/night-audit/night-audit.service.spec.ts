import { Test } from '@nestjs/testing';
import { Prisma, UserRole } from '@prisma/client';
import type { AuthUser } from '../auth/auth.constants';
import { CoreClient } from '../core/core.client';
import { HousekeepingService } from '../housekeeping/housekeeping.service';
import { PrismaService } from '../prisma/prisma.service';
import { BookingService } from '../reservations/booking.service';
import { NightAuditService } from './night-audit.service';

const PROPERTY = { id: 'prop-1', operaHotelId: 'SAND01', name: 'PlanForge Seoul', currency: 'KRW' };

const HQ: AuthUser = {
  id: 'u1',
  sub: 'u1',
  email: 'a@b.c',
  name: '본사',
  role: UserRole.MANAGER,
  propertyId: null,
};

const PROFILE = { lastName: '홍', firstName: '길동' };

function reservation(overrides: Record<string, unknown> = {}) {
  return {
    id: 'res-1',
    confirmationNumber: 'PF-1',
    profile: PROFILE,
    roomType: { code: 'STDT' },
    arrivalDate: new Date(Date.UTC(2026, 8, 1)),
    departureDate: new Date(Date.UTC(2026, 8, 3)),
    assignedRoomNumber: '1101',
    ...overrides,
  };
}

function buildPrisma(overrides: Record<string, unknown[]> = {}) {
  const findMany = jest
    .fn()
    // Order: due to arrive, due to depart, in house unassigned (folios are a separate model)
    .mockResolvedValueOnce(overrides.arrivals ?? [])
    .mockResolvedValueOnce(overrides.departures ?? [])
    .mockResolvedValueOnce(overrides.unassigned ?? []);

  return {
    property: { findUnique: jest.fn().mockResolvedValue(PROPERTY) },
    reservation: { findMany },
    folio: { findMany: jest.fn().mockResolvedValue(overrides.folios ?? []) },
  };
}

function buildCore() {
  return {
    getBusinessDate: jest.fn().mockResolvedValue({
      hotelId: 'SAND01',
      businessDate: '2026-09-02',
      calendarDate: '2026-09-03',
    }),
  };
}

async function buildService(
  prisma: ReturnType<typeof buildPrisma>,
  core: ReturnType<typeof buildCore>,
  discrepancies: unknown[] = [],
  booking: Record<string, unknown> = {},
) {
  const moduleRef = await Test.createTestingModule({
    providers: [
      NightAuditService,
      { provide: PrismaService, useValue: prisma },
      { provide: CoreClient, useValue: core },
      { provide: BookingService, useValue: { noShow: jest.fn(), ...booking } },
      {
        provide: HousekeepingService,
        useValue: {
          findDiscrepancies: jest
            .fn()
            .mockResolvedValue({ total: discrepancies.length, items: discrepancies }),
        },
      },
    ],
  }).compile();
  return moduleRef.get(NightAuditService);
}

describe('NightAuditService — 점검표', () => {
  it('남은 항목이 없으면 마감 준비 완료로 알린다', async () => {
    const service = await buildService(buildPrisma(), buildCore());
    const result = await service.review('prop-1', HQ);

    expect(result.outstanding).toBe(0);
    expect(result.ready).toBe(true);
  });

  it('영업일은 OPERA 에서 읽는다', async () => {
    const core = buildCore();
    const service = await buildService(buildPrisma(), core);
    const result = await service.review('prop-1', HQ);

    expect(core.getBusinessDate).toHaveBeenCalledWith('SAND01');
    expect(result.businessDate).toBe('2026-09-02');
    expect(result.businessDateFromOpera).toBe(true);
  });

  // A close decided silently on the wrong date shifts a day of revenue.
  it('OPERA 에 닿지 못하면 달력 날짜를 쓰되 그 사실을 알린다', async () => {
    const core = buildCore();
    core.getBusinessDate.mockRejectedValue(new Error('unreachable'));
    const service = await buildService(buildPrisma(), core);

    const result = await service.review('prop-1', HQ);
    expect(result.businessDateFromOpera).toBe(false);
    expect(result.businessDate).toBe(result.calendarDate);
  });

  it('미도착·미체크아웃·미배정·잔액·불일치를 각 항목으로 나눈다', async () => {
    const prisma = buildPrisma({
      arrivals: [reservation({ id: 'a1', confirmationNumber: 'PF-A' })],
      departures: [reservation({ id: 'd1', confirmationNumber: 'PF-D' })],
      unassigned: [reservation({ id: 'u1', confirmationNumber: 'PF-U', assignedRoomNumber: null })],
      folios: [
        {
          reservationId: 'f1',
          balance: new Prisma.Decimal(120000),
          reservation: { ...reservation({ confirmationNumber: 'PF-F' }), profile: PROFILE },
        },
      ],
    });
    const service = await buildService(prisma, buildCore(), [
      {
        room: { number: '1102', roomType: { code: 'DLXK' } },
        kind: 'OCCUPIED_BUT_CLEAN',
        reservation: 'PF-X',
      },
    ]);

    const result = await service.review('prop-1', HQ);
    const byKind = Object.fromEntries(result.sections.map((s) => [s.kind, s.items.length]));

    expect(byKind).toEqual({
      ARRIVAL_PENDING: 1,
      DEPARTURE_PENDING: 1,
      IN_HOUSE_UNASSIGNED: 1,
      OPEN_BALANCE: 1,
      ROOM_DISCREPANCY: 1,
    });
    expect(result.outstanding).toBe(5);
    expect(result.ready).toBe(false);
  });

  it('잔액은 문자열로 그대로 전달한다', async () => {
    const prisma = buildPrisma({
      folios: [
        {
          reservationId: 'f1',
          balance: new Prisma.Decimal('120000.50'),
          reservation: { ...reservation(), profile: PROFILE },
        },
      ],
    });
    const service = await buildService(prisma, buildCore());

    const result = await service.review('prop-1', HQ);
    const balances = result.sections.find((s) => s.kind === 'OPEN_BALANCE');
    expect(balances?.items[0]?.amount).toBe('120000.5');
  });

  it('다른 호텔을 요청하면 막는다', async () => {
    const service = await buildService(buildPrisma(), buildCore());
    const scoped: AuthUser = { ...HQ, propertyId: 'prop-2' };

    await expect(service.review('prop-1', scoped)).rejects.toMatchObject({
      response: { code: 'OTHER_PROPERTY_FORBIDDEN' },
    });
  });
});

describe('NightAuditService — 노쇼', () => {
  // Arrival date and status are OPERA's call. Checking again here splits the rules.
  it('예약 서비스에 그대로 위임한다', async () => {
    const noShow = jest.fn().mockResolvedValue({ id: 'res-1' });
    const service = await buildService(buildPrisma(), buildCore(), [], { noShow });

    await service.markNoShow('res-1', '연락 두절', HQ);
    expect(noShow).toHaveBeenCalledWith('res-1', '연락 두절', HQ);
  });

  it('대상이 없으면 OPERA 를 호출하지 않는다', async () => {
    const noShow = jest.fn();
    const service = await buildService(buildPrisma(), buildCore(), [], { noShow });

    await expect(service.markNoShow('', undefined, HQ)).rejects.toMatchObject({
      response: { code: 'RESERVATION_TARGET_REQUIRED' },
    });
    expect(noShow).not.toHaveBeenCalled();
  });
});
