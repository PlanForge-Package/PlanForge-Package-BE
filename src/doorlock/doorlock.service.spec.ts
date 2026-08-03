import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ReservationStatus, RoomKeyStatus, UserRole } from '@prisma/client';
import type { AuthUser } from '../auth/auth.constants';
import { PrismaService } from '../prisma/prisma.service';
import { DoorLockService } from './doorlock.service';
import { DOOR_LOCK_DRIVER, DoorLockError } from './doorlock.driver';

const HQ: AuthUser = {
  id: 'u1',
  sub: 'u1',
  email: 'a@b.c',
  name: '프런트',
  role: UserRole.FRONT_DESK,
  propertyId: null,
};

function utc(iso: string): Date {
  return new Date(`${iso}T00:00:00Z`);
}

/** 오늘 기준으로 두어 "체크아웃 시각이 지났다" 검사에 걸리지 않게 한다. */
function futureStay(overrides: Record<string, unknown> = {}) {
  const today = new Date();
  const arrival = new Date(today.getTime() - 86_400_000);
  const departure = new Date(today.getTime() + 2 * 86_400_000);

  return {
    id: 'res-1',
    propertyId: 'prop-1',
    status: ReservationStatus.IN_HOUSE,
    assignedRoomNumber: '1203',
    arrivalDate: utc(arrival.toISOString().slice(0, 10)),
    departureDate: utc(departure.toISOString().slice(0, 10)),
    property: { operaHotelId: 'SAND01', timezone: 'Asia/Seoul' },
    ...overrides,
  };
}

function activeKey(overrides: Record<string, unknown> = {}) {
  return {
    id: 'key-1',
    propertyId: 'prop-1',
    reservationId: 'res-1',
    roomNumber: '1203',
    vendorKeyId: 'MOCKKEY-AAA',
    validFrom: new Date(Date.now() - 3_600_000),
    validUntil: new Date(Date.now() + 86_400_000),
    status: RoomKeyStatus.ACTIVE,
    sequence: 1,
    issuedAt: new Date(),
    revokedAt: null,
    revokedReason: null,
    issuedById: 'u1',
    ...overrides,
  };
}

function buildPrisma(overrides: Record<string, unknown> = {}) {
  return {
    reservation: { findUnique: jest.fn().mockResolvedValue(futureStay()) },
    roomKey: {
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn().mockResolvedValue(activeKey()),
      findUniqueOrThrow: jest.fn().mockResolvedValue(activeKey({ status: RoomKeyStatus.REVOKED })),
      count: jest.fn().mockResolvedValue(0),
      create: jest.fn().mockImplementation(({ data }) => ({ id: 'key-new', ...data })),
      update: jest.fn(),
      ...(overrides.roomKey ?? {}),
    },
  };
}

function buildDriver() {
  return {
    mode: 'mock' as const,
    encode: jest.fn().mockResolvedValue({ vendorKeyId: 'MOCKKEY-NEW' }),
    revoke: jest.fn().mockResolvedValue(undefined),
  };
}

async function buildService(
  prisma: ReturnType<typeof buildPrisma>,
  driver: ReturnType<typeof buildDriver> = buildDriver(),
) {
  const moduleRef = await Test.createTestingModule({
    providers: [
      DoorLockService,
      { provide: PrismaService, useValue: prisma },
      { provide: DOOR_LOCK_DRIVER, useValue: driver },
    ],
  }).compile();
  return moduleRef.get(DoorLockService);
}

describe('DoorLockService — 발급', () => {
  it('재실 예약에 카드를 만들고 기록을 남긴다', async () => {
    const prisma = buildPrisma();
    const driver = buildDriver();
    const service = await buildService(prisma, driver);

    const key = await service.issue('res-1', {}, HQ);

    expect(driver.encode).toHaveBeenCalledWith(
      expect.objectContaining({ propertyCode: 'SAND01', roomNumber: '1203', sequence: 1 }),
    );
    expect(key.vendorKeyId).toBe('MOCKKEY-NEW');
  });

  // 아직 들어오지 않은 손님에게 카드를 주면 지금 그 방에 묵는 사람의 문이 열린다.
  it('재실 상태가 아니면 거절한다', async () => {
    const prisma = buildPrisma();
    prisma.reservation.findUnique.mockResolvedValue(
      futureStay({ status: ReservationStatus.CONFIRMED }),
    );
    const driver = buildDriver();
    const service = await buildService(prisma, driver);

    await expect(service.issue('res-1', {}, HQ)).rejects.toBeInstanceOf(BadRequestException);
    expect(driver.encode).not.toHaveBeenCalled();
  });

  it('객실이 배정되지 않았으면 거절한다', async () => {
    const prisma = buildPrisma();
    prisma.reservation.findUnique.mockResolvedValue(futureStay({ assignedRoomNumber: null }));
    const service = await buildService(prisma);

    await expect(service.issue('res-1', {}, HQ)).rejects.toThrow(/배정된 객실/);
  });

  // 분실 재발급인데 이전 카드가 살아 있으면 재발급의 의미가 없다.
  it('기본으로 이전 카드를 먼저 무효화한다', async () => {
    const prisma = buildPrisma({
      roomKey: {
        findMany: jest.fn().mockResolvedValue([activeKey()]),
        findUnique: jest.fn().mockResolvedValue(activeKey()),
        findUniqueOrThrow: jest.fn().mockResolvedValue(activeKey()),
        count: jest.fn().mockResolvedValue(1),
        create: jest.fn().mockImplementation(({ data }) => ({ id: 'key-new', ...data })),
        update: jest.fn(),
      },
    });
    const driver = buildDriver();
    const service = await buildService(prisma, driver);

    await service.issue('res-1', {}, HQ);

    expect(driver.revoke).toHaveBeenCalledWith('MOCKKEY-AAA');
    expect(prisma.roomKey.update.mock.calls[0][0].data.revokedReason).toBe('재발급');
    // 두 번째 발급이므로 차수가 올라간다.
    expect(driver.encode.mock.calls[0][0].sequence).toBe(2);
  });

  it('일행 추가 발급이면 기존 카드를 살려 둔다', async () => {
    const prisma = buildPrisma({
      roomKey: {
        findMany: jest.fn().mockResolvedValue([activeKey()]),
        count: jest.fn().mockResolvedValue(1),
        create: jest.fn().mockImplementation(({ data }) => ({ id: 'key-new', ...data })),
        update: jest.fn(),
      },
    });
    const driver = buildDriver();
    const service = await buildService(prisma, driver);

    await service.issue('res-1', { replaceExisting: false }, HQ);
    expect(driver.revoke).not.toHaveBeenCalled();
  });

  /*
   * 결과를 알 수 없는 실패와 명확한 거절은 다르게 안내해야 한다. 전자는 카드가
   * 만들어졌을 수 있어 인코더를 확인해야 한다.
   */
  it('연결 실패는 카드가 만들어졌을 수 있다고 알린다', async () => {
    const prisma = buildPrisma();
    const driver = buildDriver();
    driver.encode.mockRejectedValue(new DoorLockError('timeout', false));
    const service = await buildService(prisma, driver);

    await expect(service.issue('res-1', {}, HQ)).rejects.toThrow(/카드가 만들어졌을 수 있으니/);
    expect(prisma.roomKey.create).not.toHaveBeenCalled();
  });

  it('벤더가 거절하면 그 사유를 그대로 전한다', async () => {
    const prisma = buildPrisma();
    const driver = buildDriver();
    driver.encode.mockRejectedValue(new DoorLockError('인코더 용지 없음', true));
    const service = await buildService(prisma, driver);

    await expect(service.issue('res-1', {}, HQ)).rejects.toThrow(/인코더 용지 없음/);
  });

  // 다른 호텔 예약에 카드를 발급하면 그 호텔 객실이 열린다.
  it('다른 호텔 예약은 막는다', async () => {
    const prisma = buildPrisma();
    const service = await buildService(prisma);
    const scoped: AuthUser = { ...HQ, propertyId: 'prop-2' };

    await expect(service.issue('res-1', {}, scoped)).rejects.toThrow(/접근할 수 없습니다/);
  });
});

describe('DoorLockService — 무효화', () => {
  /*
   * 순서가 중요하다. 로컬만 먼저 바꾸면 벤더 호출이 실패했을 때 "죽었다고 적혀
   * 있지만 실제로는 열리는 카드" 가 남고 아무도 모른다.
   */
  it('벤더에서 먼저 죽이고 로컬을 표시한다', async () => {
    const prisma = buildPrisma();
    const driver = buildDriver();
    const service = await buildService(prisma, driver);

    await service.revoke('key-1', { reason: '분실' }, HQ);

    expect(driver.revoke).toHaveBeenCalledWith('MOCKKEY-AAA');
    expect(prisma.roomKey.update.mock.calls[0][0].data).toEqual(
      expect.objectContaining({ status: RoomKeyStatus.REVOKED, revokedReason: '분실' }),
    );
  });

  it('벤더 무효화가 실패하면 로컬도 바꾸지 않는다', async () => {
    const prisma = buildPrisma();
    const driver = buildDriver();
    driver.revoke.mockRejectedValue(new Error('unreachable'));
    const service = await buildService(prisma, driver);

    await expect(service.revoke('key-1', {}, HQ)).rejects.toThrow(/아직 열릴 수 있으니/);
    expect(prisma.roomKey.update).not.toHaveBeenCalled();
  });

  // 이미 죽은 카드를 다시 죽이라는 요청은 성공으로 둔다. 멱등해야 한다.
  it('이미 무효화된 카드는 그대로 돌려준다', async () => {
    const prisma = buildPrisma();
    prisma.roomKey.findUnique.mockResolvedValue(activeKey({ status: RoomKeyStatus.REVOKED }));
    const driver = buildDriver();
    const service = await buildService(prisma, driver);

    const result = await service.revoke('key-1', {}, HQ);
    expect(result.status).toBe(RoomKeyStatus.REVOKED);
    expect(driver.revoke).not.toHaveBeenCalled();
  });

  it('없는 카드는 404 로 알린다', async () => {
    const prisma = buildPrisma();
    prisma.roomKey.findUnique.mockResolvedValue(null);
    const service = await buildService(prisma);

    await expect(service.revoke('nope', {}, HQ)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('살아 있는 카드를 한 번에 전부 죽인다', async () => {
    const prisma = buildPrisma({
      roomKey: {
        findMany: jest
          .fn()
          .mockResolvedValue([activeKey(), activeKey({ id: 'key-2', vendorKeyId: 'MOCKKEY-BBB' })]),
        update: jest.fn(),
      },
    });
    const driver = buildDriver();
    const service = await buildService(prisma, driver);

    const revoked = await service.revokeActive('res-1', '체크아웃');

    expect(revoked).toBe(2);
    expect(driver.revoke).toHaveBeenCalledTimes(2);
  });
});

describe('DoorLockService — 조회', () => {
  // 배치로 상태를 갱신하면 배치가 밀린 동안 화면이 거짓말을 한다.
  it('유효 기간이 지난 카드는 만료로 보여 준다', async () => {
    const prisma = buildPrisma({
      roomKey: {
        findMany: jest
          .fn()
          .mockResolvedValue([activeKey({ validUntil: new Date(Date.now() - 3_600_000) })]),
      },
    });
    const service = await buildService(prisma);

    const result = await service.listByReservation('res-1', HQ);
    expect(result.items[0]?.status).toBe(RoomKeyStatus.EXPIRED);
  });

  // 모의 드라이버로 발급한 카드로는 어떤 문도 열리지 않는다. 화면이 알아야 한다.
  it('드라이버 모드를 함께 알린다', async () => {
    const service = await buildService(buildPrisma());
    const result = await service.listByReservation('res-1', HQ);
    expect(result.driverMode).toBe('mock');
  });
});
