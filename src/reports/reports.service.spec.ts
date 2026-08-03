import { BadRequestException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Prisma, ReservationStatus, RoomStatus, UserRole } from '@prisma/client';
import type { AuthUser } from '../auth/auth.constants';
import { PrismaService } from '../prisma/prisma.service';
import { ReportsService } from './reports.service';

const PROPERTY = { id: 'prop-1', operaHotelId: 'SAND01', name: 'PlanForge Seoul', currency: 'KRW' };

const HQ: AuthUser = {
  id: 'u1',
  sub: 'u1',
  email: 'a@b.c',
  name: '본사',
  role: UserRole.MANAGER,
  propertyId: null,
};

function utc(iso: string): Date {
  return new Date(`${iso}T00:00:00Z`);
}

function stay(
  arrival: string,
  departure: string,
  total: number | null,
  status: ReservationStatus = ReservationStatus.CHECKED_OUT,
) {
  return {
    status,
    arrivalDate: utc(arrival),
    departureDate: utc(departure),
    totalAmount: total === null ? null : new Prisma.Decimal(total),
  };
}

function buildPrisma(options: {
  rooms?: RoomStatus[];
  reservations?: ReturnType<typeof stay>[];
  postings?: Array<{ type: string; amount: Prisma.Decimal; postedAt: Date }>;
}) {
  const rooms = (options.rooms ?? Array(10).fill(RoomStatus.CLEAN)).map((status) => ({ status }));
  return {
    property: { findUnique: jest.fn().mockResolvedValue(PROPERTY) },
    room: { findMany: jest.fn().mockResolvedValue(rooms) },
    reservation: { findMany: jest.fn().mockResolvedValue(options.reservations ?? []) },
    posting: { findMany: jest.fn().mockResolvedValue(options.postings ?? []) },
  };
}

async function buildService(prisma: ReturnType<typeof buildPrisma>) {
  const moduleRef = await Test.createTestingModule({
    providers: [ReportsService, { provide: PrismaService, useValue: prisma }],
  }).compile();
  return moduleRef.get(ReportsService);
}

describe('ReportsService — 점유율', () => {
  it('출발일 당일은 방을 쓰지 않으므로 세지 않는다', async () => {
    const service = await buildService(
      buildPrisma({ reservations: [stay('2026-08-01', '2026-08-03', 200000)] }),
    );

    const result = await service.daily(
      { propertyId: 'prop-1', from: '2026-08-01', to: '2026-08-03' },
      HQ,
    );
    const sold = result.rows.map((row) => row.roomsSold);
    expect(sold).toEqual([1, 1, 0]);
  });

  // 판매 불가 객실을 분모에 넣으면 점유율이 실제보다 낮게 나온다.
  it('고장·판매중지 객실은 분모에서 뺀다', async () => {
    const service = await buildService(
      buildPrisma({
        rooms: [
          RoomStatus.CLEAN,
          RoomStatus.CLEAN,
          RoomStatus.OUT_OF_ORDER,
          RoomStatus.OUT_OF_SERVICE,
        ],
        reservations: [stay('2026-08-01', '2026-08-02', 100000)],
      }),
    );

    const result = await service.daily(
      { propertyId: 'prop-1', from: '2026-08-01', to: '2026-08-01' },
      HQ,
    );
    expect(result.roomsAvailable).toBe(2);
    expect(result.rows[0]?.occupancy).toBe(0.5);
  });

  // 취소·노쇼가 점유율에 들어가면 팔지 않은 방을 판 것으로 집계된다.
  it('예약분과 실적을 나눠 센다', async () => {
    const service = await buildService(
      buildPrisma({
        reservations: [
          stay('2026-08-01', '2026-08-02', 100000, ReservationStatus.IN_HOUSE),
          stay('2026-08-01', '2026-08-02', 100000, ReservationStatus.CONFIRMED),
        ],
      }),
    );

    const result = await service.daily(
      { propertyId: 'prop-1', from: '2026-08-01', to: '2026-08-01' },
      HQ,
    );
    expect(result.rows[0]?.roomsSold).toBe(1);
    expect(result.rows[0]?.roomsBooked).toBe(1);
  });
});

describe('ReportsService — ADR·RevPAR', () => {
  it('총액을 박수로 나눠 각 날짜에 배분한다', async () => {
    const service = await buildService(
      buildPrisma({ reservations: [stay('2026-08-01', '2026-08-03', 200000)] }),
    );

    const result = await service.daily(
      { propertyId: 'prop-1', from: '2026-08-01', to: '2026-08-02' },
      HQ,
    );
    expect(result.rows[0]?.roomRevenue).toBe('100000.00');
    expect(result.rows[0]?.adr).toBe('100000.00');
    // 객실 10실 기준
    expect(result.rows[0]?.revpar).toBe('10000.00');
  });

  it('판매가 없으면 ADR 을 0 으로 둔다', async () => {
    const service = await buildService(buildPrisma({}));

    const result = await service.daily(
      { propertyId: 'prop-1', from: '2026-08-01', to: '2026-08-01' },
      HQ,
    );
    expect(result.rows[0]?.adr).toBe('0.00');
    expect(result.rows[0]?.occupancy).toBe(0);
  });

  // 금액이 없는 예약을 0 으로 세지 않으면 ADR 이 통째로 무너진다.
  it('총액이 없는 예약은 매출 0 으로 다룬다', async () => {
    const service = await buildService(
      buildPrisma({ reservations: [stay('2026-08-01', '2026-08-02', null)] }),
    );

    const result = await service.daily(
      { propertyId: 'prop-1', from: '2026-08-01', to: '2026-08-01' },
      HQ,
    );
    expect(result.rows[0]?.roomsSold).toBe(1);
    expect(result.rows[0]?.roomRevenue).toBe('0.00');
  });

  it('기간 합계로 ADR·RevPAR 을 다시 계산한다', async () => {
    const service = await buildService(
      buildPrisma({
        reservations: [
          stay('2026-08-01', '2026-08-02', 100000),
          stay('2026-08-02', '2026-08-03', 300000),
        ],
      }),
    );

    const result = await service.daily(
      { propertyId: 'prop-1', from: '2026-08-01', to: '2026-08-02' },
      HQ,
    );
    expect(result.totals.roomsSold).toBe(2);
    expect(result.totals.roomRevenue).toBe('400000.00');
    expect(result.totals.adr).toBe('200000.00');
    // 10실 × 2박
    expect(result.totals.revpar).toBe('20000.00');
  });
});

describe('ReportsService — 포스팅 매출', () => {
  // 계약 기준 매출과 실제 청구를 섞으면 차이를 설명할 수 없게 된다.
  it('청구·결제·조정을 따로 합산하고 미수를 계산한다', async () => {
    const service = await buildService(
      buildPrisma({
        postings: [
          { type: 'CHARGE', amount: new Prisma.Decimal(100000), postedAt: utc('2026-08-01') },
          { type: 'TAX', amount: new Prisma.Decimal(10000), postedAt: utc('2026-08-01') },
          { type: 'PAYMENT', amount: new Prisma.Decimal(-50000), postedAt: utc('2026-08-01') },
          { type: 'ADJUSTMENT', amount: new Prisma.Decimal(-5000), postedAt: utc('2026-08-01') },
        ],
      }),
    );

    const result = await service.daily(
      { propertyId: 'prop-1', from: '2026-08-01', to: '2026-08-01' },
      HQ,
    );
    expect(result.postings.charges).toBe('110000.00');
    expect(result.postings.payments).toBe('-50000.00');
    expect(result.postings.adjustments).toBe('-5000.00');
    // amount 는 이미 부호가 붙어 있다. 결제를 다시 빼면 두 번 빠진다.
    expect(result.postings.outstanding).toBe('55000.00');
  });

  it('전액 결제되면 미수가 0 이다', async () => {
    const service = await buildService(
      buildPrisma({
        postings: [
          { type: 'CHARGE', amount: new Prisma.Decimal(200000), postedAt: utc('2026-08-01') },
          { type: 'PAYMENT', amount: new Prisma.Decimal(-200000), postedAt: utc('2026-08-01') },
        ],
      }),
    );

    const result = await service.daily(
      { propertyId: 'prop-1', from: '2026-08-01', to: '2026-08-01' },
      HQ,
    );
    expect(result.postings.outstanding).toBe('0.00');
  });
});

describe('ReportsService — 기간 검증', () => {
  it('뒤집힌 기간은 거절한다', async () => {
    const service = await buildService(buildPrisma({}));
    await expect(
      service.daily({ propertyId: 'prop-1', from: '2026-08-10', to: '2026-08-01' }, HQ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('지나치게 넓은 기간은 거절한다', async () => {
    const service = await buildService(buildPrisma({}));
    await expect(
      service.daily({ propertyId: 'prop-1', from: '2026-01-01', to: '2026-12-31' }, HQ),
    ).rejects.toThrow(/최대 92일/);
  });

  it('다른 호텔을 요청하면 막는다', async () => {
    const service = await buildService(buildPrisma({}));
    const scoped: AuthUser = { ...HQ, propertyId: 'prop-2' };
    await expect(
      service.daily({ propertyId: 'prop-1', from: '2026-08-01', to: '2026-08-01' }, scoped),
    ).rejects.toThrow(/접근할 수 없습니다/);
  });
});
