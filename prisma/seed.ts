/**
 * Development seed data.
 *
 * A minimum set for checking screens and APIs against real data. Never run it
 * against a production database — it aborts below when NODE_ENV=production.
 *
 * Everything is an upsert, so repeated runs give the same result.
 */

import { PrismaClient, ProfileType, ReservationStatus, RoomStatus, UserRole } from '@prisma/client';
import * as bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

/** `YYYY-MM-DD` to a UTC-midnight Date, so @db.Date columns do not shift a day. */
function d(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

/** A date offset from today, so states like "arriving today" hold whenever it runs. */
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

/**
 * One account per role, so permission boundaries can be checked from the screens.
 *
 * `assigned: false` means no property (head office). Tying an admin to one hotel
 * makes the other hotels unmanageable in a multi-hotel setup — neither registering
 * a hotel nor staffing it works. Admins stay head-office accounts.
 */
const USERS = [
  { email: 'admin@planforge.local', name: '관리자', role: UserRole.ADMIN, assigned: false },
  { email: 'manager@planforge.local', name: '지배인', role: UserRole.MANAGER, assigned: true },
  {
    email: 'frontdesk@planforge.local',
    name: '프론트데스크',
    role: UserRole.FRONT_DESK,
    assigned: true,
  },
  {
    email: 'housekeeping@planforge.local',
    name: '하우스키핑',
    role: UserRole.HOUSEKEEPING,
    assigned: true,
  },
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

/**
 * Booking origins are deliberately varied.
 *
 * All on one channel, the channel performance screen is a single row and verifies
 * nothing. OTA, direct and walk-in mixed makes dependence and ADR gaps visible.
 */
const RESERVATIONS = [
  // In house — a room is assigned. Verifies the in-house marks on list and room screens.
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
    source: 'OTA',
    market: 'LEISURE',
    channel: 'BOOKINGCOM',
  },
  // Confirmed, arriving today — for testing check-in.
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
    source: 'DIRECT',
    market: 'TRANSIENT',
    channel: 'WEB',
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
    source: 'CORPORATE',
    market: 'CORPORATE',
    channel: 'FRONTDESK',
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
    source: 'OTA',
    market: 'LEISURE',
    channel: 'EXPEDIA',
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
    source: 'DIRECT',
    market: 'TRANSIENT',
    channel: 'WEB',
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
    source: 'PHONE',
    market: 'LEISURE',
    channel: null,
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

  // Accounts. Passwords come from env so no plaintext lives in source.
  const seedPassword = process.env.SEED_PASSWORD ?? 'planforge';
  if (seedPassword.length < 8) {
    throw new Error('SEED_PASSWORD 는 8자 이상이어야 합니다.');
  }
  const passwordHash = await bcrypt.hash(seedPassword, 10);

  for (const { assigned, ...user } of USERS) {
    const propertyId = assigned ? property.id : null;
    await prisma.user.upsert({
      where: { email: user.email },
      // Password and property are reset every run — it stops a value changed during
      // development from locking someone out or trapping an admin in one hotel.
      update: { name: user.name, role: user.role, passwordHash, active: true, propertyId },
      create: { ...user, passwordHash, propertyId },
    });
  }

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
      // Occupancy is rebuilt below from in-house reservations. Without clearing it here,
      // rooms checked in on an earlier run stay occupied and block the next check-in.
      update: { status: room.status, floor: room.floor, roomTypeId, occupied: false },
      create: {
        propertyId: property.id,
        roomTypeId,
        number: room.number,
        floor: room.floor,
        status: room.status,
      },
    });
  }

  // Release occupancy on this hotel's other rooms too, including any made outside this list.
  await prisma.room.updateMany({
    where: { propertyId: property.id },
    data: { occupied: false },
  });

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
      sourceCode: r.source,
      marketCode: r.market,
      channelCode: r.channel,
    };

    /*
     * No OPERA id is attached.
     *
     * A number invented here does not exist in OPERA. Now that reservations, folios
     * and check-in are all delegated, a made-up id makes every action on that
     * reservation fail with "reservation not found" for no obvious reason.
     *
     * These reservations are a local sample to fill the list, search and report
     * screens. For a linked reservation, create one from the screen or pull it
     * from OPERA with `POST /api/sync/reservations`.
     */
    const reservation = await prisma.reservation.upsert({
      where: { confirmationNumber: r.conf },
      // Clear ids invented by an earlier seed too. Left behind, an existing dev
      // database keeps failing with "reservation not found".
      update: { ...data, operaReservationId: null },
      create: { ...data, confirmationNumber: r.conf },
    });

    /*
     * Folios attached to this reservation are removed.
     *
     * Repeated runs must give the same result. A bill left by an earlier seed or a
     * window left by an earlier test shows a balance OPERA does not have.
     */
    await prisma.folio.deleteMany({ where: { reservationId: reservation.id } });

    // In-house reservations set their room occupied.
    if (r.status === ReservationStatus.IN_HOUSE && r.room) {
      await prisma.room.update({
        where: { propertyId_number: { propertyId: property.id, number: r.room } },
        data: { occupied: true },
      });

      /*
       * No folios are created.
       *
       * The ledger's source is OPERA and local rows are a copy. Inventing balances
       * and transactions here puts a bill on screen that OPERA does not have, and
       * the copy diverges the moment a real charge is posted. To test a folio with
       * a balance, book and check in from the screen, then post a charge.
       */
    }
  }

  const counts = {
    properties: await prisma.property.count(),
    users: await prisma.user.count(),
    rooms: await prisma.room.count(),
    profiles: await prisma.profile.count(),
    reservations: await prisma.reservation.count(),
  };
  console.log('시드 완료:', counts);
  console.log('시드 예약은 OPERA 에 연결되지 않은 로컬 표본입니다.');
  console.log(
    '  체크인·요금·결제까지 시험하려면 화면에서 새 예약을 만들거나' +
      ' POST /api/sync/reservations 로 OPERA 에서 가져와 주세요.',
  );
  console.log(`계정 비밀번호: ${seedPassword} (SEED_PASSWORD 로 변경 가능)`);
  for (const user of USERS) {
    console.log(`  ${user.role.padEnd(12)} ${user.email}`);
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
