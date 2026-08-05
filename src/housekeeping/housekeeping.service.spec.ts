import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { RoomStatus, SyncStatus, TaskStatus, UserRole } from '@prisma/client';
import type { AuthUser } from '../auth/auth.constants';
import { CoreClient } from '../core/core.client';
import { PrismaService } from '../prisma/prisma.service';
import { HousekeepingService } from './housekeeping.service';
import { fromOperaRoomStatus, toOperaRoomStatus } from './room-status.mapper';

const PROPERTY = { id: 'prop-1', operaHotelId: 'SAND01', name: 'Seoul', currency: 'KRW' };

function userWith(role: UserRole, id = 'u1', propertyId: string | null = null): AuthUser {
  return { id, sub: id, email: 'a@b.c', name: '직원', role, propertyId };
}

const MANAGER = userWith(UserRole.MANAGER);
const CLEANER = userWith(UserRole.HOUSEKEEPING, 'hk-1', 'prop-1');

function buildPrisma() {
  return {
    property: { findUnique: jest.fn().mockResolvedValue(PROPERTY) },
    room: {
      findUnique: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
      update: jest.fn().mockResolvedValue({ id: 'room-1' }),
    },
    reservation: { findMany: jest.fn().mockResolvedValue([]) },
    user: { findUnique: jest.fn() },
    housekeepingTask: {
      findUnique: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
      createMany: jest.fn(),
      update: jest.fn().mockResolvedValue({ id: 'task-1' }),
    },
    syncLog: { create: jest.fn().mockResolvedValue({ id: 'log-1' }), update: jest.fn() },
  };
}

function buildCore() {
  return {
    updateRoomStatus: jest.fn().mockResolvedValue({
      hotelId: 'SAND01',
      roomNumber: '1101',
      status: 'Clean',
      occupied: false,
    }),
  };
}

async function buildService(
  prisma: ReturnType<typeof buildPrisma>,
  core: ReturnType<typeof buildCore>,
) {
  const moduleRef = await Test.createTestingModule({
    providers: [
      HousekeepingService,
      { provide: PrismaService, useValue: prisma },
      { provide: CoreClient, useValue: core },
    ],
  }).compile();
  return moduleRef.get(HousekeepingService);
}

describe('room-status.mapper', () => {
  it('왕복 변환이 값을 지킨다', () => {
    for (const status of Object.values(RoomStatus)) {
      expect(fromOperaRoomStatus(toOperaRoomStatus(status))).toBe(status);
    }
  });

  // Leaving it as needing cleaning is safer than wrongly putting it back on sale.
  it('모르는 값은 DIRTY 로 떨어뜨린다', () => {
    expect(fromOperaRoomStatus('SomethingNew')).toBe(RoomStatus.DIRTY);
  });
});

describe('HousekeepingService — 객실 상태', () => {
  function roomIn(overrides: Record<string, unknown> = {}) {
    const prisma = buildPrisma();
    prisma.room.findUnique.mockResolvedValue({
      id: 'room-1',
      number: '1101',
      propertyId: 'prop-1',
      occupied: false,
      status: RoomStatus.DIRTY,
      property: PROPERTY,
      ...overrides,
    });
    return prisma;
  }

  it('OPERA 에 위임하고 확정된 값을 반영한다', async () => {
    const prisma = roomIn();
    const core = buildCore();
    core.updateRoomStatus.mockResolvedValue({
      hotelId: 'SAND01',
      roomNumber: '1101',
      status: 'Inspected',
      occupied: false,
    });
    const service = await buildService(prisma, core);

    await service.updateRoomStatus('room-1', { status: RoomStatus.CLEAN }, MANAGER);

    expect(core.updateRoomStatus).toHaveBeenCalledWith(
      '1101',
      expect.objectContaining({ hotelId: 'SAND01', status: 'Clean' }),
    );
    // The stored value must be OPERA's confirmed INSPECTED, not the CLEAN we sent.
    expect(prisma.room.update.mock.calls[0][0].data.status).toBe(RoomStatus.INSPECTED);
  });

  it('재실 객실을 판매 불가로 돌리는 요청은 OPERA 를 부르지 않는다', async () => {
    const prisma = roomIn({ occupied: true });
    const core = buildCore();
    const service = await buildService(prisma, core);

    await expect(
      service.updateRoomStatus('room-1', { status: RoomStatus.OUT_OF_ORDER }, MANAGER),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(core.updateRoomStatus).not.toHaveBeenCalled();
  });

  it('OPERA 가 실패하면 이력을 FAILED 로 남기고 로컬을 건드리지 않는다', async () => {
    const prisma = roomIn();
    const core = buildCore();
    core.updateRoomStatus.mockRejectedValue(new Error('OPERA 거절'));
    const service = await buildService(prisma, core);

    await expect(
      service.updateRoomStatus('room-1', { status: RoomStatus.CLEAN }, MANAGER),
    ).rejects.toThrow(/OPERA 거절/);
    expect(prisma.room.update).not.toHaveBeenCalled();
    expect(prisma.syncLog.update.mock.calls[0][0].data.status).toBe(SyncStatus.FAILED);
  });

  it('없는 객실이면 404 를 낸다', async () => {
    const prisma = buildPrisma();
    prisma.room.findUnique.mockResolvedValue(null);
    const service = await buildService(prisma, buildCore());

    await expect(
      service.updateRoomStatus('nope', { status: RoomStatus.CLEAN }, MANAGER),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('HousekeepingService — 작업 조회', () => {
  it('하우스키핑 역할은 본인 작업으로 고정된다', async () => {
    const prisma = buildPrisma();
    const service = await buildService(prisma, buildCore());

    // Another person's id is ignored.
    await service.listTasks({ assignedToId: 'someone-else' }, CLEANER);

    expect(prisma.housekeepingTask.findMany.mock.calls[0][0].where.assignedToId).toBe('hk-1');
  });

  it('매니저는 `me` 로 본인 작업만 볼 수 있다', async () => {
    const prisma = buildPrisma();
    const service = await buildService(prisma, buildCore());

    await service.listTasks({ assignedToId: 'me' }, MANAGER);

    expect(prisma.housekeepingTask.findMany.mock.calls[0][0].where.assignedToId).toBe('u1');
  });

  it('미배정만 조회하면 담당자 조건 대신 null 을 건다', async () => {
    const prisma = buildPrisma();
    const service = await buildService(prisma, buildCore());

    await service.listTasks({ unassignedOnly: true }, MANAGER);

    expect(prisma.housekeepingTask.findMany.mock.calls[0][0].where.assignedToId).toBeNull();
  });
});

describe('HousekeepingService — 작업 생성', () => {
  it('이미 있는 작업은 다시 만들지 않는다', async () => {
    const prisma = buildPrisma();
    prisma.room.findMany.mockResolvedValue([{ id: 'r1' }, { id: 'r2' }]);
    prisma.housekeepingTask.findMany.mockResolvedValue([{ roomId: 'r1' }]);
    const service = await buildService(prisma, buildCore());

    const result = await service.generateTasks({ propertyId: 'prop-1' }, MANAGER);

    expect(result.created).toBe(1);
    expect(result.existing).toBe(1);
    expect(prisma.housekeepingTask.createMany.mock.calls[0][0].data).toHaveLength(1);
  });

  it('새로 만들 것이 없으면 쓰기를 하지 않는다', async () => {
    const prisma = buildPrisma();
    prisma.room.findMany.mockResolvedValue([{ id: 'r1' }]);
    prisma.housekeepingTask.findMany.mockResolvedValue([{ roomId: 'r1' }]);
    const service = await buildService(prisma, buildCore());

    await service.generateTasks({ propertyId: 'prop-1' }, MANAGER);

    expect(prisma.housekeepingTask.createMany).not.toHaveBeenCalled();
  });
});

describe('HousekeepingService — 배정·진행', () => {
  function taskIn(assignedToId: string | null = null) {
    const prisma = buildPrisma();
    prisma.housekeepingTask.findUnique.mockResolvedValue({
      id: 'task-1',
      propertyId: 'prop-1',
      assignedToId,
      startedAt: null,
    });
    return prisma;
  }

  it('비활성 계정에는 배정하지 않는다', async () => {
    const prisma = taskIn();
    prisma.user.findUnique.mockResolvedValue({ id: 'x', active: false, propertyId: 'prop-1' });
    const service = await buildService(prisma, buildCore());

    await expect(
      service.assignTask('task-1', { assignedToId: 'x' }, MANAGER),
    ).rejects.toMatchObject({ response: { code: 'TASK_ASSIGNEE_INVALID' } });
  });

  // Assigned to another hotel's staff, that person never sees the task on their screen.
  it('다른 호텔 소속 직원에게는 배정하지 않는다', async () => {
    const prisma = taskIn();
    prisma.user.findUnique.mockResolvedValue({ id: 'x', active: true, propertyId: 'prop-2' });
    const service = await buildService(prisma, buildCore());

    await expect(
      service.assignTask('task-1', { assignedToId: 'x' }, MANAGER),
    ).rejects.toMatchObject({ response: { code: 'TASK_ASSIGNEE_OTHER_PROPERTY' } });
  });

  it('빈 값이면 배정을 해제한다', async () => {
    const prisma = taskIn('hk-1');
    const service = await buildService(prisma, buildCore());

    await service.assignTask('task-1', {}, MANAGER);

    expect(prisma.housekeepingTask.update.mock.calls[0][0].data.assignedToId).toBeNull();
  });

  // Completing someone else's task puts a room that was never cleaned back on sale.
  it('하우스키핑은 남의 작업을 바꿀 수 없다', async () => {
    const prisma = taskIn('other-person');
    const service = await buildService(prisma, buildCore());

    await expect(
      service.updateTask('task-1', { status: TaskStatus.DONE }, CLEANER),
    ).rejects.toMatchObject({ response: { code: 'TASK_NOT_MINE' } });
  });

  it('본인 작업은 바꿀 수 있다', async () => {
    const prisma = taskIn('hk-1');
    const service = await buildService(prisma, buildCore());

    await expect(
      service.updateTask('task-1', { status: TaskStatus.DONE }, CLEANER),
    ).resolves.toBeDefined();
  });

  it('시작하면 startedAt 을, 완료하면 completedAt 을 남긴다', async () => {
    const prisma = taskIn('hk-1');
    const service = await buildService(prisma, buildCore());

    await service.updateTask('task-1', { status: TaskStatus.IN_PROGRESS }, CLEANER);
    expect(prisma.housekeepingTask.update.mock.calls[0][0].data.startedAt).toBeInstanceOf(Date);

    await service.updateTask('task-1', { status: TaskStatus.INSPECTED }, CLEANER);
    expect(prisma.housekeepingTask.update.mock.calls[1][0].data.completedAt).toBeInstanceOf(Date);
  });
});

describe('HousekeepingService — 불일치 감지', () => {
  function withRoomsAndReservations(
    rooms: Array<Record<string, unknown>>,
    inHouse: Array<{ assignedRoomNumber: string; confirmationNumber: string }>,
  ) {
    const prisma = buildPrisma();
    prisma.room.findMany.mockResolvedValue(rooms);
    prisma.reservation.findMany.mockResolvedValue(inHouse);
    return prisma;
  }

  it('재실 표시인데 재실 예약이 없으면 잡아낸다', async () => {
    const prisma = withRoomsAndReservations(
      [{ number: '1101', occupied: true, status: RoomStatus.DIRTY }],
      [],
    );
    const service = await buildService(prisma, buildCore());

    const result = await service.findDiscrepancies('prop-1', MANAGER);
    expect(result.items[0]?.kind).toBe('OCCUPIED_WITHOUT_RESERVATION');
  });

  it('재실 예약이 있는데 객실이 비어 있으면 잡아낸다', async () => {
    const prisma = withRoomsAndReservations(
      [{ number: '1201', occupied: false, status: RoomStatus.CLEAN }],
      [{ assignedRoomNumber: '1201', confirmationNumber: 'PF-1' }],
    );
    const service = await buildService(prisma, buildCore());

    const result = await service.findDiscrepancies('prop-1', MANAGER);
    expect(result.items[0]).toMatchObject({
      kind: 'RESERVATION_WITHOUT_OCCUPANCY',
      reservation: 'PF-1',
    });
  });

  it('재실인데 청소 완료 표시면 잡아낸다', async () => {
    const prisma = withRoomsAndReservations(
      [{ number: '1301', occupied: true, status: RoomStatus.CLEAN }],
      [{ assignedRoomNumber: '1301', confirmationNumber: 'PF-2' }],
    );
    const service = await buildService(prisma, buildCore());

    const result = await service.findDiscrepancies('prop-1', MANAGER);
    expect(result.items[0]?.kind).toBe('OCCUPIED_BUT_CLEAN');
  });

  it('정상 상태는 잡아내지 않는다', async () => {
    const prisma = withRoomsAndReservations(
      [
        { number: '1401', occupied: false, status: RoomStatus.DIRTY },
        { number: '1402', occupied: true, status: RoomStatus.INSPECTED },
      ],
      [{ assignedRoomNumber: '1402', confirmationNumber: 'PF-3' }],
    );
    const service = await buildService(prisma, buildCore());

    const result = await service.findDiscrepancies('prop-1', MANAGER);
    expect(result.total).toBe(0);
  });
});
