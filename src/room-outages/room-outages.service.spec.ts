import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { RoomOutageKind, RoomStatus, UserRole } from '@prisma/client';
import type { AuthUser } from '../auth/auth.constants';
import { CoreClient } from '../core/core.client';
import { PrismaService } from '../prisma/prisma.service';
import { RoomOutagesService } from './room-outages.service';

const ACTOR: AuthUser = {
  id: 'u1',
  sub: 'u1',
  email: 'a@b.c',
  name: '프런트',
  role: UserRole.FRONT_DESK,
  propertyId: null,
};

function day(offset: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
}

function dto(overrides: Record<string, unknown> = {}) {
  return {
    propertyId: 'prop-1',
    roomNumber: '1101',
    kind: RoomOutageKind.OUT_OF_ORDER,
    startDate: day(2),
    endDate: day(4),
    reason: '욕실 누수',
    ...overrides,
  } as Parameters<RoomOutagesService['create']>[0];
}

function buildPrisma(overrides: Record<string, unknown> = {}) {
  const tx = {
    roomOutage: {
      create: jest.fn().mockImplementation(({ data }) => ({
        id: 'out-new',
        ...data,
        kind: data.kind,
      })),
      update: jest.fn().mockImplementation(({ data }) => ({ id: 'out-1', ...data })),
    },
    room: { update: jest.fn() },
  };

  return {
    tx,
    property: {
      findUnique: jest.fn().mockResolvedValue({
        id: 'prop-1',
        operaHotelId: 'SAND01',
        currency: 'KRW',
      }),
    },
    room: {
      findUnique: jest.fn().mockResolvedValue({
        id: 'room-1',
        number: '1101',
        occupied: false,
        status: RoomStatus.CLEAN,
      }),
      ...((overrides.room as object) ?? {}),
    },
    roomOutage: {
      findFirst: jest.fn().mockResolvedValue(null),
      findUnique: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      ...((overrides.roomOutage as object) ?? {}),
    },
    reservation: {
      findFirst: jest.fn().mockResolvedValue(null),
      ...((overrides.reservation as object) ?? {}),
    },
    syncLog: {
      create: jest.fn().mockResolvedValue({ id: 'log-1' }),
      update: jest.fn().mockResolvedValue({}),
    },
    $transaction: jest.fn((fn: (t: typeof tx) => unknown) => fn(tx)),
  };
}

function buildCore(overrides: Record<string, unknown> = {}) {
  return {
    createRoomOutage: jest.fn().mockImplementation((input) => ({
      outageId: 'OOO-701',
      hotelId: 'SAND01',
      roomNumber: input.roomNumber,
      kind: input.kind,
      startDate: input.startDate,
      endDate: input.endDate,
      reason: input.reason,
      returnStatus: input.returnStatus,
    })),
    releaseRoomOutage: jest.fn().mockResolvedValue({ outageId: 'OOO-701' }),
    ...overrides,
  };
}

async function buildService(
  prisma: ReturnType<typeof buildPrisma>,
  core: ReturnType<typeof buildCore> = buildCore(),
) {
  const moduleRef = await Test.createTestingModule({
    providers: [
      RoomOutagesService,
      { provide: PrismaService, useValue: prisma },
      { provide: CoreClient, useValue: core },
    ],
  }).compile();
  return moduleRef.get(RoomOutagesService);
}

describe('RoomOutagesService — 등록', () => {
  it('OPERA 에 먼저 반영한 뒤 로컬에 옮겨 적는다', async () => {
    const prisma = buildPrisma();
    const core = buildCore();
    const service = await buildService(prisma, core);

    await service.create(dto(), ACTOR);

    expect(core.createRoomOutage).toHaveBeenCalledWith(
      expect.objectContaining({
        hotelId: 'SAND01',
        roomNumber: '1101',
        kind: 'OutOfOrder',
        returnStatus: 'Dirty',
      }),
    );
    expect(prisma.tx.roomOutage.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ operaId: 'OOO-701' }) }),
    );
  });

  it('미래 기간은 오늘의 객실 상태를 건드리지 않는다', async () => {
    const prisma = buildPrisma();
    const service = await buildService(prisma);

    await service.create(dto(), ACTOR);

    expect(prisma.tx.room.update).not.toHaveBeenCalled();
  });

  it('오늘을 포함하면 객실 상태도 지금 바꾼다', async () => {
    const prisma = buildPrisma();
    const service = await buildService(prisma);

    await service.create(dto({ startDate: day(0), endDate: day(3) }), ACTOR);

    expect(prisma.tx.room.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: RoomStatus.OUT_OF_ORDER } }),
    );
  });

  it('OPERA 가 거절하면 로컬에 남기지 않는다', async () => {
    const prisma = buildPrisma();
    const core = buildCore({
      createRoomOutage: jest.fn().mockRejectedValue(new ConflictException('거절')),
    });
    const service = await buildService(prisma, core);

    await expect(service.create(dto(), ACTOR)).rejects.toThrow(ConflictException);
    expect(prisma.tx.roomOutage.create).not.toHaveBeenCalled();
  });

  it('종료일이 시작일보다 앞서면 호출 전에 막는다', async () => {
    const prisma = buildPrisma();
    const core = buildCore();
    const service = await buildService(prisma, core);

    await expect(
      service.create(dto({ startDate: day(5), endDate: day(3) }), ACTOR),
    ).rejects.toThrow(BadRequestException);
    expect(core.createRoomOutage).not.toHaveBeenCalled();
  });

  it('이미 지난 기간은 막는다', async () => {
    const prisma = buildPrisma();
    const service = await buildService(prisma);

    await expect(
      service.create(dto({ startDate: day(-9), endDate: day(-5) }), ACTOR),
    ).rejects.toThrow(BadRequestException);
  });

  it('없는 객실은 막는다', async () => {
    const prisma = buildPrisma({ room: { findUnique: jest.fn().mockResolvedValue(null) } });
    const service = await buildService(prisma);

    await expect(service.create(dto({ roomNumber: '9999' }), ACTOR)).rejects.toThrow(
      NotFoundException,
    );
  });

  it('기간이 겹치는 기록이 있으면 막는다', async () => {
    const prisma = buildPrisma({
      roomOutage: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'out-old',
          startDate: new Date(`${day(1)}T00:00:00Z`),
          endDate: new Date(`${day(6)}T00:00:00Z`),
        }),
      },
    });
    const service = await buildService(prisma);

    await expect(service.create(dto(), ACTOR)).rejects.toThrow(ConflictException);
  });

  it('그 기간에 배정된 예약이 있으면 막는다', async () => {
    const prisma = buildPrisma({
      reservation: {
        findFirst: jest.fn().mockResolvedValue({ id: 'res-1', confirmationNumber: 'CONF-1' }),
      },
    });
    const core = buildCore();
    const service = await buildService(prisma, core);

    await expect(service.create(dto(), ACTOR)).rejects.toThrow(/CONF-1/);
    expect(core.createRoomOutage).not.toHaveBeenCalled();
  });

  it('재실 중인 객실을 오늘부터 빼려 하면 막는다', async () => {
    const prisma = buildPrisma({
      room: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'room-1',
          number: '1101',
          occupied: true,
          status: RoomStatus.CLEAN,
        }),
      },
    });
    const service = await buildService(prisma);

    await expect(
      service.create(dto({ startDate: day(0), endDate: day(2) }), ACTOR),
    ).rejects.toThrow(ConflictException);
  });

  it('재실 중이어도 손님이 나간 뒤 기간은 받는다', async () => {
    const prisma = buildPrisma({
      room: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'room-1',
          number: '1101',
          occupied: true,
          status: RoomStatus.CLEAN,
        }),
      },
    });
    const service = await buildService(prisma);

    await expect(service.create(dto(), ACTOR)).resolves.toBeDefined();
  });
});

describe('RoomOutagesService — 해제', () => {
  function releasable(overrides: Record<string, unknown> = {}) {
    return {
      id: 'out-1',
      propertyId: 'prop-1',
      roomId: 'room-1',
      operaId: 'OOO-701',
      kind: RoomOutageKind.OUT_OF_ORDER,
      startDate: new Date(`${day(0)}T00:00:00Z`),
      endDate: new Date(`${day(3)}T00:00:00Z`),
      returnStatus: RoomStatus.DIRTY,
      releasedAt: null,
      property: { operaHotelId: 'SAND01' },
      room: { number: '1101' },
      ...overrides,
    };
  }

  it('OPERA 에서 지운 뒤 복귀 상태로 되돌린다', async () => {
    const prisma = buildPrisma({
      roomOutage: { findUnique: jest.fn().mockResolvedValue(releasable()) },
    });
    const core = buildCore();
    const service = await buildService(prisma, core);

    await service.release('out-1', {}, ACTOR);

    expect(core.releaseRoomOutage).toHaveBeenCalledWith('OOO-701', {
      hotelId: 'SAND01',
      reason: undefined,
    });
    // 청소 여부를 알 수 없으므로 CLEAN 이 아니라 DIRTY 로 돌아온다.
    expect(prisma.tx.room.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: RoomStatus.DIRTY } }),
    );
  });

  it('지난 기간을 해제하면 지금 객실 상태는 건드리지 않는다', async () => {
    const prisma = buildPrisma({
      roomOutage: {
        findUnique: jest.fn().mockResolvedValue(
          releasable({
            startDate: new Date(`${day(5)}T00:00:00Z`),
            endDate: new Date(`${day(8)}T00:00:00Z`),
          }),
        ),
      },
    });
    const service = await buildService(prisma);

    await service.release('out-1', {}, ACTOR);

    expect(prisma.tx.room.update).not.toHaveBeenCalled();
  });

  it('이미 해제된 기록은 다시 해제하지 않는다', async () => {
    const prisma = buildPrisma({
      roomOutage: {
        findUnique: jest.fn().mockResolvedValue(releasable({ releasedAt: new Date() })),
      },
    });
    const core = buildCore();
    const service = await buildService(prisma, core);

    await expect(service.release('out-1', {}, ACTOR)).rejects.toThrow(ConflictException);
    expect(core.releaseRoomOutage).not.toHaveBeenCalled();
  });

  it('OPERA 가 거절하면 로컬도 해제하지 않는다', async () => {
    const prisma = buildPrisma({
      roomOutage: { findUnique: jest.fn().mockResolvedValue(releasable()) },
    });
    const core = buildCore({
      releaseRoomOutage: jest.fn().mockRejectedValue(new NotFoundException('없음')),
    });
    const service = await buildService(prisma, core);

    await expect(service.release('out-1', {}, ACTOR)).rejects.toThrow(NotFoundException);
    expect(prisma.tx.roomOutage.update).not.toHaveBeenCalled();
  });

  it('없는 기록은 막는다', async () => {
    const prisma = buildPrisma();
    const service = await buildService(prisma);

    await expect(service.release('nope', {}, ACTOR)).rejects.toThrow(NotFoundException);
  });
});
