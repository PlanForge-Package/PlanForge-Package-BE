/**
 * 개발용 시드 데이터.
 *
 * 화면과 API 를 실제 데이터로 확인하기 위한 최소 세트다. 운영 DB 에는 절대 돌리지
 * 않는다 — 아래에서 NODE_ENV=production 이면 즉시 중단한다.
 *
 * 여러 번 돌려도 결과가 같도록 모두 upsert 로 작성했다.
 */

import { PrismaClient, ProfileType, ReservationStatus, RoomStatus, UserRole } from '@prisma/client';
import * as bcrypt from 'bcryptjs';

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

/**
 * 역할별로 하나씩. 권한 경계를 화면에서 바로 확인할 수 있게 한다.
 *
 * `assigned: false` 는 소속 없음(본사)이다. 관리자를 특정 호텔에 묶으면 다중 호텔
 * 운영에서 다른 호텔을 관리할 수 없게 된다 — 호텔 등록도, 그 호텔 직원 배치도
 * 막힌다. 관리자는 본사 계정으로 둔다.
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
 * 예약 경로를 서로 다르게 둔다.
 *
 * 전부 같은 채널이면 채널별 실적 화면이 한 줄짜리가 되어 아무것도 검증하지
 * 못한다. OTA·자사·프런트가 섞여 있어야 의존도와 ADR 차이가 눈에 보인다.
 */
const RESERVATIONS = [
  // 재실 — 객실이 배정된 상태. 목록·객실 화면의 재실 표기를 확인할 수 있다.
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

  // 계정. 비밀번호는 환경변수로 받아 소스에 평문을 남기지 않는다.
  const seedPassword = process.env.SEED_PASSWORD ?? 'planforge';
  if (seedPassword.length < 8) {
    throw new Error('SEED_PASSWORD 는 8자 이상이어야 합니다.');
  }
  const passwordHash = await bcrypt.hash(seedPassword, 10);

  for (const { assigned, ...user } of USERS) {
    const propertyId = assigned ? property.id : null;
    await prisma.user.upsert({
      where: { email: user.email },
      // 비밀번호와 소속도 매번 되돌린다 — 개발 중 바꿔 놓고 잊어 로그인하지 못하거나
      // 관리자가 한 호텔에 갇히는 일을 막는다.
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
      // 점유는 아래에서 재실 예약을 보고 다시 세운다. 여기서 함께 초기화하지 않으면
      // 이전 실행에서 체크인한 객실이 계속 점유 상태로 남아 다음 체크인이 막힌다.
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

  // 이 호텔의 나머지 객실(시드 목록 밖에서 만들어진 것 포함)도 점유를 푼다.
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
     * OPERA 번호를 붙이지 않는다.
     *
     * 여기서 지어낸 번호는 OPERA 에 없다. 예약·폴리오·체크인이 모두 OPERA 에
     * 위임된 뒤로는, 있지도 않은 번호를 달아 두면 그 예약으로 무엇을 하든
     * "예약을 찾을 수 없습니다" 로 막히고 원인을 찾기 어렵다.
     *
     * 이 예약들은 목록·검색·실적 화면을 채우기 위한 로컬 표본이다. 연동된
     * 예약이 필요하면 화면에서 새로 만들거나 `POST /api/sync/reservations` 로
     * OPERA 에서 가져온다.
     */
    const reservation = await prisma.reservation.upsert({
      where: { confirmationNumber: r.conf },
      // 이전 시드가 지어내 둔 번호도 지운다. 남겨 두면 이미 만들어진 개발
      // DB 에서는 계속 "예약을 찾을 수 없습니다" 로 막힌다.
      update: { ...data, operaReservationId: null },
      create: { ...data, confirmationNumber: r.conf },
    });

    /*
     * 이 예약에 붙어 있던 폴리오는 지운다.
     *
     * 여러 번 돌려도 결과가 같아야 한다. 이전 시드가 만들어 둔 계산서나 앞선
     * 시험이 남긴 창구가 남아 있으면 OPERA 에 없는 잔액이 계속 화면에 뜬다.
     */
    await prisma.folio.deleteMany({ where: { reservationId: reservation.id } });

    // 재실 예약은 객실을 점유 상태로 맞춘다.
    if (r.status === ReservationStatus.IN_HOUSE && r.room) {
      await prisma.room.update({
        where: { propertyId_number: { propertyId: property.id, number: r.room } },
        data: { occupied: true },
      });

      /*
       * 폴리오는 새로 만들지 않는다.
       *
       * 회계 원장은 OPERA 가 원천이고 로컬 행은 그 사본이다. 여기서 잔액과
       * 거래를 지어내면 OPERA 에 없는 계산서가 화면에 뜨고, 실제로 요금을
       * 달려는 순간 사본과 원장이 갈린다. 잔액이 남은 폴리오를 시험하려면
       * 화면에서 예약을 만들어 체크인한 뒤 요금을 달아 주세요.
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
