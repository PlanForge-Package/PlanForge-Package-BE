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
  codes: { sourceCode?: string; marketCode?: string; channelCode?: string } = {},
) {
  return {
    status,
    arrivalDate: utc(arrival),
    departureDate: utc(departure),
    totalAmount: total === null ? null : new Prisma.Decimal(total),
    sourceCode: codes.sourceCode ?? null,
    marketCode: codes.marketCode ?? null,
    channelCode: codes.channelCode ?? null,
  };
}

function outage(roomId: string, startDate: string, endDate: string, releasedAt?: string) {
  return {
    roomId,
    startDate: utc(startDate),
    endDate: utc(endDate),
    releasedAt: releasedAt ? utc(releasedAt) : null,
  };
}

function buildPrisma(options: {
  rooms?: RoomStatus[];
  reservations?: ReturnType<typeof stay>[];
  postings?: Array<{ type: string; amount: Prisma.Decimal; postedAt: Date }>;
  outages?: ReturnType<typeof outage>[];
}) {
  const rooms = (options.rooms ?? Array(10).fill(RoomStatus.CLEAN)).map((status, index) => ({
    id: `room-${index + 1}`,
    status,
  }));
  return {
    property: { findUnique: jest.fn().mockResolvedValue(PROPERTY) },
    room: { findMany: jest.fn().mockResolvedValue(rooms) },
    reservation: { findMany: jest.fn().mockResolvedValue(options.reservations ?? []) },
    posting: { findMany: jest.fn().mockResolvedValue(options.postings ?? []) },
    roomOutage: { findMany: jest.fn().mockResolvedValue(options.outages ?? []) },
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

  // Out-of-order rooms leave inventory, so they leave the denominator too.
  it('고장 기간인 객실은 그 날짜의 분모에서 뺀다', async () => {
    const service = await buildService(
      buildPrisma({
        rooms: Array(4).fill(RoomStatus.CLEAN),
        reservations: [stay('2026-08-01', '2026-08-02', 100000)],
        outages: [
          outage('room-3', '2026-08-01', '2026-08-05'),
          outage('room-4', '2026-08-01', '2026-08-05'),
        ],
      }),
    );

    const result = await service.daily(
      { propertyId: 'prop-1', from: '2026-08-01', to: '2026-08-01' },
      HQ,
    );
    expect(result.rows[0]?.roomsAvailable).toBe(2);
    expect(result.rows[0]?.occupancy).toBe(0.5);
  });

  // Out-of-service rooms stay in inventory, so the denominator holds. That difference
  // is why the two are split — the service reads only OOO records.
  it('판매중지는 분모를 줄이지 않는다', async () => {
    const prisma = buildPrisma({
      rooms: Array(4).fill(RoomStatus.CLEAN),
      reservations: [stay('2026-08-01', '2026-08-02', 100000)],
    });
    const service = await buildService(prisma);

    const result = await service.daily(
      { propertyId: 'prop-1', from: '2026-08-01', to: '2026-08-01' },
      HQ,
    );

    expect(prisma.roomOutage.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ kind: 'OUT_OF_ORDER' }) }),
    );
    expect(result.rows[0]?.roomsAvailable).toBe(4);
  });

  // Once the outage ends the room is sellable again. Subtracting past it inflates occupancy.
  it('고장 기간이 끝난 날짜는 다시 분모에 넣는다', async () => {
    const service = await buildService(
      buildPrisma({
        rooms: Array(4).fill(RoomStatus.CLEAN),
        outages: [outage('room-3', '2026-08-01', '2026-08-01')],
      }),
    );

    const result = await service.daily(
      { propertyId: 'prop-1', from: '2026-08-01', to: '2026-08-02' },
      HQ,
    );
    expect(result.rows.map((row) => row.roomsAvailable)).toEqual([3, 4]);
  });

  // Released early, the days after that were sellable again.
  it('해제된 뒤 날짜는 분모에 되돌린다', async () => {
    const service = await buildService(
      buildPrisma({
        rooms: Array(4).fill(RoomStatus.CLEAN),
        outages: [outage('room-3', '2026-08-01', '2026-08-05', '2026-08-02')],
      }),
    );

    const result = await service.daily(
      { propertyId: 'prop-1', from: '2026-08-01', to: '2026-08-03' },
      HQ,
    );
    expect(result.rows.map((row) => row.roomsAvailable)).toEqual([3, 4, 4]);
  });

  // The denominator differs per date, so the total sums per date. Multiplying one day is wrong.
  it('기간 합계 분모는 날짜별 값의 합이다', async () => {
    const service = await buildService(
      buildPrisma({
        rooms: Array(4).fill(RoomStatus.CLEAN),
        outages: [outage('room-3', '2026-08-01', '2026-08-01')],
      }),
    );

    const result = await service.daily(
      { propertyId: 'prop-1', from: '2026-08-01', to: '2026-08-02' },
      HQ,
    );
    expect(result.totals.roomsAvailable).toBe(7);
  });

  // Cancellations and no-shows in occupancy count rooms we never sold as sold.
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
    // Based on 10 rooms
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

  // Not counting reservations without an amount as 0 destroys ADR entirely.
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
    // 10 rooms x 2 nights
    expect(result.totals.revpar).toBe('20000.00');
  });
});

describe('ReportsService — 포스팅 매출', () => {
  // Mixing contracted revenue with actual charges leaves the difference unexplainable.
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
    // amount is already signed. Subtracting payments again deducts them twice.
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

describe('ReportsService — 채널 분해', () => {
  it('채널별 판매·매출·ADR·비중을 낸다', async () => {
    const service = await buildService(
      buildPrisma({
        reservations: [
          stay('2026-08-01', '2026-08-02', 300000, ReservationStatus.CHECKED_OUT, {
            channelCode: 'BOOKINGCOM',
          }),
          stay('2026-08-01', '2026-08-02', 100000, ReservationStatus.CHECKED_OUT, {
            channelCode: 'WEB',
          }),
          stay('2026-08-01', '2026-08-02', 100000, ReservationStatus.CHECKED_OUT, {
            channelCode: 'WEB',
          }),
        ],
      }),
    );

    const result = await service.daily(
      { propertyId: 'prop-1', from: '2026-08-01', to: '2026-08-01' },
      HQ,
    );

    // Largest revenue comes first.
    expect(result.breakdown.channel.map((row) => row.code)).toEqual(['BOOKINGCOM', 'WEB']);
    const web = result.breakdown.channel.find((row) => row.code === 'WEB');
    expect(web?.roomsSold).toBe(2);
    expect(web?.roomRevenue).toBe('200000.00');
    expect(web?.adr).toBe('100000.00');
    expect(web?.share).toBeCloseTo(2 / 3, 4);
  });

  // Dropped, the breakdown would not sum to the total and neither figure could be trusted.
  it('코드가 없는 예약은 (미지정) 으로 모은다', async () => {
    const service = await buildService(
      buildPrisma({ reservations: [stay('2026-08-01', '2026-08-02', 100000)] }),
    );

    const result = await service.daily(
      { propertyId: 'prop-1', from: '2026-08-01', to: '2026-08-01' },
      HQ,
    );
    expect(result.breakdown.channel[0]?.code).toBe('(미지정)');
  });

  it('분해 합계는 전체 합계와 같다', async () => {
    const service = await buildService(
      buildPrisma({
        reservations: [
          stay('2026-08-01', '2026-08-03', 400000, ReservationStatus.CHECKED_OUT, {
            sourceCode: 'OTA',
          }),
          stay('2026-08-01', '2026-08-02', 150000, ReservationStatus.CHECKED_OUT, {
            sourceCode: 'PHONE',
          }),
        ],
      }),
    );

    const result = await service.daily(
      { propertyId: 'prop-1', from: '2026-08-01', to: '2026-08-02' },
      HQ,
    );

    const sold = result.breakdown.source.reduce((sum, row) => sum + row.roomsSold, 0);
    const revenue = result.breakdown.source.reduce((sum, row) => sum + Number(row.roomRevenue), 0);
    expect(sold).toBe(result.totals.roomsSold);
    expect(revenue).toBeCloseTo(Number(result.totals.roomRevenue), 2);
  });

  // Cancellations and no-shows in channel performance count unsold rooms as sold.
  it('실적이 아닌 예약은 분해에서도 뺀다', async () => {
    const service = await buildService(
      buildPrisma({
        reservations: [
          stay('2026-08-01', '2026-08-02', 100000, ReservationStatus.CONFIRMED, {
            channelCode: 'WEB',
          }),
        ],
      }),
    );

    const result = await service.daily(
      { propertyId: 'prop-1', from: '2026-08-01', to: '2026-08-01' },
      HQ,
    );
    expect(result.breakdown.channel).toEqual([]);
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
    ).rejects.toMatchObject({ response: { code: 'RANGE_TOO_LONG' } });
  });

  it('다른 호텔을 요청하면 막는다', async () => {
    const service = await buildService(buildPrisma({}));
    const scoped: AuthUser = { ...HQ, propertyId: 'prop-2' };
    await expect(
      service.daily({ propertyId: 'prop-1', from: '2026-08-01', to: '2026-08-01' }, scoped),
    ).rejects.toMatchObject({ response: { code: 'OTHER_PROPERTY_FORBIDDEN' } });
  });
});
