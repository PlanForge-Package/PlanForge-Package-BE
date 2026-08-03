/**
 * 개발용 시드 데이터.
 *
 * 화면과 API 를 실제 데이터로 확인하기 위한 최소 세트다. 운영 DB 에는 절대 돌리지
 * 않는다 — 아래에서 NODE_ENV=production 이면 즉시 중단한다.
 *
 * 여러 번 돌려도 결과가 같도록 모두 upsert 로 작성했다.
 */

import {
  FolioStatus,
  PostingType,
  PrismaClient,
  ProfileType,
  ReservationStatus,
  RoomStatus,
} from '@prisma/client';

const prisma = new PrismaClient();

/** `YYYY-MM-DD` 를 UTC 자정 Date 로. @db.Date 컬럼이 하루 밀리지 않게 한다. */
function d(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

/** 오늘 기준 오프셋 날짜. 시드가 언제 돌아도 "오늘 도착" 같은 상태가 유지된다. */
function day(offset: number): string {
  const base = new Date();
  base.setUTCDate(base.getUTCDate() + offset);
  return base.toISOString().slice(0, 10);
}

const ROOM_TYPES = [
  { code: 'STDT', name: 'Standard Twin', maxOccupancy: 2 },
  { code: 'DLXK', name: 'Deluxe King', maxOccupancy: 2 },
  { code: 'SUIT', name: 'Suite', maxOccupancy: 4 },
];

const RATE_PLANS = [
  { code: 'BAR', name: 'Best Available Rate', baseAmount: '240000' },
  { code: 'CORP', name: 'Corporate', baseAmount: '190000' },
];

const ROOMS = [
  { number: '1101', floor: '11', type: 'STDT', status: RoomStatus.CLEAN },
  { number: '1102', floor: '11', type: 'STDT', status: RoomStatus.DIRTY },
  { number: '1103', floor: '11', type: 'DLXK', status: RoomStatus.INSPECTED },
  { number: '1201', floor: '12', type: 'DLXK', status: RoomStatus.CLEAN },
  { number: '1202', floor: '12', type: 'DLXK', status: RoomStatus.CLEAN },
  { number: '1203', floor: '12', type: 'DLXK', status: RoomStatus.INSPECTED },
  { number: '1501', floor: '15', type: 'SUIT', status: RoomStatus.CLEAN },
  { number: '1502', floor: '15', type: 'SUIT', status: RoomStatus.OUT_OF_ORDER },
];

const GUESTS = [
  { opera: 'PRF-0001', last: '김', first: 'Minsu', email: 'minsu.kim@example.com', vip: false },
  { opera: 'PRF-0002', last: '이', first: 'Jiwoo', email: 'jiwoo.lee@example.com', vip: true },
  {
    opera: 'PRF-0003',
    last: 'Park',
    first: 'Soyeon',
    email: 'soyeon.park@example.com',
    vip: false,
  },
  { opera: 'PRF-0004', last: '최', first: 'Junho', email: 'junho.choi@example.com', vip: false },
  { opera: 'PRF-0005', last: '정', first: 'Haeun', email: 'haeun.jung@example.com', vip: false },
  { opera: 'PRF-0006', last: 'Yoon', first: 'Daniel', email: 'daniel.yoon@example.com', vip: true },
];

const RESERVATIONS = [
  // 재실 — 객실 배정 + 폴리오 개설까지 되어 있어 체크아웃을 바로 시험할 수 있다.
  {
    conf: 'PF-000001',
    guest: 'PRF-0001',
    type: 'DLXK',
    rate: 'BAR',
    arrival: day(-1),
    departure: day(1),
    status: ReservationStatus.IN_HOUSE,
    room: '1203',
    total: '480000',
  },
  // 오늘 도착 확정 — 체크인 시험용.
  {
    conf: 'PF-000002',
    guest: 'PRF-0002',
    type: 'STDT',
    rate: 'BAR',
    arrival: day(0),
    departure: day(2),
    status: ReservationStatus.CONFIRMED,
    room: null,
    total: '380000',
  },
  {
    conf: 'PF-000003',
    guest: 'PRF-0003',
    type: 'SUIT',
    rate: 'CORP',
    arrival: day(1),
    departure: day(4),
    status: ReservationStatus.RESERVED,
    room: null,
    total: '1200000',
  },
  {
    conf: 'PF-000004',
    guest: 'PRF-0004',
    type: 'DLXK',
    rate: 'BAR',
    arrival: day(-3),
    departure: day(-1),
    status: ReservationStatus.CHECKED_OUT,
    room: '1103',
    total: '460000',
  },
  {
    conf: 'PF-000005',
    guest: 'PRF-0005',
    type: 'STDT',
    rate: 'BAR',
    arrival: day(-2),
    departure: day(-1),
    status: ReservationStatus.CANCELLED,
    room: null,
    total: null,
  },
  {
    conf: 'PF-000006',
    guest: 'PRF-0006',
    type: 'SUIT',
    rate: 'CORP',
    arrival: day(3),
    departure: day(5),
    status: ReservationStatus.WAITLISTED,
    room: null,
    total: null,
  },
];

async function main(): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('시드는 운영 환경에서 실행할 수 없습니다.');
  }

  const property = await prisma.property.upsert({
    where: { operaHotelId: 'SAND01' },
    update: {},
    create: {
      operaHotelId: 'SAND01',
      name: 'PlanForge Seoul',
      timezone: 'Asia/Seoul',
      currency: 'KRW',
      address: '서울특별시 중구',
    },
  });

  const roomTypes = new Map<string, string>();
  for (const rt of ROOM_TYPES) {
    const saved = await prisma.roomType.upsert({
      where: { propertyId_code: { propertyId: property.id, code: rt.code } },
      update: { name: rt.name, maxOccupancy: rt.maxOccupancy },
      create: { propertyId: property.id, ...rt },
    });
    roomTypes.set(rt.code, saved.id);
  }

  const ratePlans = new Map<string, string>();
  for (const rp of RATE_PLANS) {
    const saved = await prisma.ratePlan.upsert({
      where: { propertyId_code: { propertyId: property.id, code: rp.code } },
      update: { name: rp.name, baseAmount: rp.baseAmount },
      create: { propertyId: property.id, ...rp, currency: 'KRW' },
    });
    ratePlans.set(rp.code, saved.id);
  }

  for (const room of ROOMS) {
    const roomTypeId = roomTypes.get(room.type);
    if (!roomTypeId) throw new Error(`알 수 없는 객실 타입: ${room.type}`);

    await prisma.room.upsert({
      where: { propertyId_number: { propertyId: property.id, number: room.number } },
      update: { status: room.status, floor: room.floor, roomTypeId },
      create: {
        propertyId: property.id,
        roomTypeId,
        number: room.number,
        floor: room.floor,
        status: room.status,
      },
    });
  }

  const profiles = new Map<string, string>();
  for (const guest of GUESTS) {
    const saved = await prisma.profile.upsert({
      where: { operaProfileId: guest.opera },
      update: { firstName: guest.first, lastName: guest.last, email: guest.email, vip: guest.vip },
      create: {
        operaProfileId: guest.opera,
        type: ProfileType.GUEST,
        firstName: guest.first,
        lastName: guest.last,
        email: guest.email,
        vip: guest.vip,
        nationality: 'KR',
      },
    });
    profiles.set(guest.opera, saved.id);
  }

  for (const r of RESERVATIONS) {
    const profileId = profiles.get(r.guest);
    const roomTypeId = roomTypes.get(r.type);
    const ratePlanId = ratePlans.get(r.rate);
    if (!profileId || !roomTypeId || !ratePlanId) {
      throw new Error(`예약 ${r.conf} 의 참조를 찾을 수 없습니다.`);
    }

    const data = {
      propertyId: property.id,
      profileId,
      roomTypeId,
      ratePlanId,
      status: r.status,
      arrivalDate: d(r.arrival),
      departureDate: d(r.departure),
      adults: 2,
      children: 0,
      assignedRoomNumber: r.room,
      totalAmount: r.total,
      currency: 'KRW',
    };

    const reservation = await prisma.reservation.upsert({
      where: { confirmationNumber: r.conf },
      update: data,
      create: { ...data, confirmationNumber: r.conf, operaReservationId: `OPERA-${r.conf}` },
    });

    // 재실 예약은 객실을 점유 상태로 맞추고 잔액이 있는 폴리오를 붙인다.
    if (r.status === ReservationStatus.IN_HOUSE && r.room) {
      await prisma.room.update({
        where: { propertyId_number: { propertyId: property.id, number: r.room } },
        data: { occupied: true },
      });

      const folio = await prisma.folio.upsert({
        where: { reservationId_window: { reservationId: reservation.id, window: 1 } },
        update: {},
        create: { reservationId: reservation.id, window: 1, currency: 'KRW' },
      });

      // 이미 거래가 있으면 다시 넣지 않는다 — 시드를 여러 번 돌려도 잔액이 불어나지 않게.
      const existing = await prisma.posting.count({ where: { folioId: folio.id } });
      if (existing === 0) {
        await prisma.posting.createMany({
          data: [
            {
              folioId: folio.id,
              type: PostingType.CHARGE,
              transactionCode: '1000',
              description: '객실료',
              amount: '400000',
            },
            {
              folioId: folio.id,
              type: PostingType.TAX,
              transactionCode: '9000',
              description: '부가세',
              amount: '40000',
            },
            {
              folioId: folio.id,
              type: PostingType.PAYMENT,
              transactionCode: '5000',
              description: '카드 선결제',
              amount: '-340000',
            },
          ],
        });

        // 잔액 = 청구 - 결제. 체크아웃 차단 로직을 시험할 수 있도록 일부러 남겨 둔다.
        await prisma.folio.update({
          where: { id: folio.id },
          data: { balance: '100000', status: FolioStatus.OPEN },
        });
      }
    }
  }

  const counts = {
    properties: await prisma.property.count(),
    rooms: await prisma.room.count(),
    profiles: await prisma.profile.count(),
    reservations: await prisma.reservation.count(),
  };
  console.log('시드 완료:', counts);
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
