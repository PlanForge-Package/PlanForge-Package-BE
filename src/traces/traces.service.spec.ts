import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { TraceDepartment, TraceStatus, UserRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { TracesService } from './traces.service';

const ACTOR = {
  id: 'user-1',
  sub: 'user-1',
  email: 'front@planforge.local',
  name: '프런트',
  role: UserRole.FRONT_DESK,
  propertyId: 'prop-1',
} as const;

function utc(iso: string): Date {
  return new Date(`${iso}T00:00:00.000Z`);
}

function reservation(overrides: Record<string, unknown> = {}) {
  return {
    id: 'res-1',
    propertyId: 'prop-1',
    departureDate: utc('2026-08-10'),
    ...overrides,
  };
}

function trace(overrides: Record<string, unknown> = {}) {
  return {
    id: 'trace-1',
    propertyId: 'prop-1',
    reservationId: 'res-1',
    department: TraceDepartment.HOUSEKEEPING,
    dueDate: utc('2026-08-05'),
    note: '유아용 침대',
    status: TraceStatus.PENDING,
    ...overrides,
  };
}

function buildPrisma(overrides: Record<string, unknown> = {}) {
  return {
    reservation: {
      findUnique: jest.fn().mockResolvedValue(reservation()),
      ...((overrides.reservation as object) ?? {}),
    },
    reservationTrace: {
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockImplementation(({ data }) => trace(data)),
      update: jest.fn().mockImplementation(({ data }) => trace(data)),
      delete: jest.fn(),
      ...((overrides.reservationTrace as object) ?? {}),
    },
  };
}

async function buildService(prisma: ReturnType<typeof buildPrisma>) {
  const moduleRef = await Test.createTestingModule({
    providers: [TracesService, { provide: PrismaService, useValue: prisma }],
  }).compile();
  return moduleRef.get(TracesService);
}

const DTO = {
  department: TraceDepartment.HOUSEKEEPING,
  dueDate: '2026-08-05',
  note: '  유아용 침대  ',
};

describe('TracesService — 등록', () => {
  it('예약의 호텔로 지시를 만든다', async () => {
    const prisma = buildPrisma();
    const service = await buildService(prisma);

    await service.create('res-1', DTO, ACTOR);

    const created = prisma.reservationTrace.create.mock.calls[0][0].data;
    expect(created.propertyId).toBe('prop-1');
    expect(created.reservationId).toBe('res-1');
    expect(created.createdById).toBe('user-1');
    // Leading and trailing spaces disturb the ordering in the list.
    expect(created.note).toBe('유아용 침대');
  });

  /*
   * Dated after the guest leaves, it shows on that department's list for the day
   * but the subject is gone.
   */
  it('출발일 이후 날짜는 거절한다', async () => {
    const prisma = buildPrisma();
    const service = await buildService(prisma);

    await expect(service.create('res-1', { ...DTO, dueDate: '2026-08-11' }, ACTOR)).rejects.toThrow(
      /출발일/,
    );
  });

  it('출발일 당일은 받는다', async () => {
    const prisma = buildPrisma();
    const service = await buildService(prisma);

    await expect(
      service.create('res-1', { ...DTO, dueDate: '2026-08-10' }, ACTOR),
    ).resolves.toBeDefined();
  });

  // Pre-arrival preparation is valid.
  it('도착 전 날짜는 막지 않는다', async () => {
    const prisma = buildPrisma();
    const service = await buildService(prisma);

    await expect(
      service.create('res-1', { ...DTO, dueDate: '2026-08-01' }, ACTOR),
    ).resolves.toBeDefined();
  });

  it('없는 예약이면 404 를 낸다', async () => {
    const prisma = buildPrisma({ reservation: { findUnique: jest.fn().mockResolvedValue(null) } });
    const service = await buildService(prisma);

    await expect(service.create('nope', DTO, ACTOR)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('다른 호텔의 예약은 막는다', async () => {
    const prisma = buildPrisma({
      reservation: {
        findUnique: jest.fn().mockResolvedValue(reservation({ propertyId: 'prop-9' })),
      },
    });
    const service = await buildService(prisma);

    await expect(service.create('res-1', DTO, ACTOR)).rejects.toThrow(/접근할 수 없습니다/);
  });
});

describe('TracesService — 목록', () => {
  it('날짜와 부서로 좁힌다', async () => {
    const prisma = buildPrisma();
    const service = await buildService(prisma);

    await service.list({ date: '2026-08-05', department: TraceDepartment.HOUSEKEEPING }, ACTOR);

    expect(prisma.reservationTrace.findMany.mock.calls[0][0].where).toEqual(
      expect.objectContaining({
        propertyId: 'prop-1',
        dueDate: utc('2026-08-05'),
        department: TraceDepartment.HOUSEKEEPING,
      }),
    );
  });

  it('날짜를 생략하면 오늘로 본다', async () => {
    const prisma = buildPrisma();
    const service = await buildService(prisma);

    const result = await service.list({}, ACTOR);
    expect(result.date).toBe(new Date().toISOString().slice(0, 10));
  });

  // Outstanding items come first so the morning list shows what to do.
  it('미처리를 앞에 둔다', async () => {
    const prisma = buildPrisma();
    const service = await buildService(prisma);

    await service.list({}, ACTOR);
    expect(prisma.reservationTrace.findMany.mock.calls[0][0].orderBy[0]).toEqual({ status: 'asc' });
  });

  it('예약별 목록은 지난 것도 함께 준다', async () => {
    const prisma = buildPrisma();
    const service = await buildService(prisma);

    await service.listByReservation('res-1', ACTOR);

    const where = prisma.reservationTrace.findMany.mock.calls[0][0].where;
    expect(where).toEqual({ reservationId: 'res-1' });
  });
});

describe('TracesService — 처리·삭제', () => {
  it('처리하면 누가 했는지 남긴다', async () => {
    const prisma = buildPrisma({
      reservationTrace: { findUnique: jest.fn().mockResolvedValue(trace()) },
    });
    const service = await buildService(prisma);

    await service.complete('trace-1', ACTOR);

    const data = prisma.reservationTrace.update.mock.calls[0][0].data;
    expect(data.status).toBe(TraceStatus.DONE);
    expect(data.completedById).toBe('user-1');
    expect(data.completedAt).toBeInstanceOf(Date);
  });

  it('이미 처리된 지시는 다시 처리하지 않는다', async () => {
    const prisma = buildPrisma({
      reservationTrace: {
        findUnique: jest.fn().mockResolvedValue(trace({ status: TraceStatus.DONE })),
      },
    });
    const service = await buildService(prisma);

    await expect(service.complete('trace-1', ACTOR)).rejects.toBeInstanceOf(ConflictException);
  });

  it('잘못 건 지시는 거둘 수 있다', async () => {
    const prisma = buildPrisma({
      reservationTrace: { findUnique: jest.fn().mockResolvedValue(trace()) },
    });
    const service = await buildService(prisma);

    await service.remove('trace-1', ACTOR);
    expect(prisma.reservationTrace.delete).toHaveBeenCalledWith({ where: { id: 'trace-1' } });
  });

  /*
   * What was done is the history. Deleting it becomes indistinguishable from "not done".
   */
  it('처리된 지시는 지우지 못한다', async () => {
    const prisma = buildPrisma({
      reservationTrace: {
        findUnique: jest.fn().mockResolvedValue(trace({ status: TraceStatus.DONE })),
      },
    });
    const service = await buildService(prisma);

    await expect(service.remove('trace-1', ACTOR)).rejects.toBeInstanceOf(ConflictException);
  });

  it('없는 지시는 404 를 낸다', async () => {
    const prisma = buildPrisma();
    const service = await buildService(prisma);

    await expect(service.complete('nope', ACTOR)).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.remove('nope', ACTOR)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('다른 호텔의 지시는 막는다', async () => {
    const prisma = buildPrisma({
      reservationTrace: {
        findUnique: jest.fn().mockResolvedValue(trace({ propertyId: 'prop-9' })),
      },
    });
    const service = await buildService(prisma);

    await expect(service.complete('trace-1', ACTOR)).rejects.toThrow(/접근할 수 없습니다/);
  });
});

describe('TracesService — 날짜 처리', () => {
  // @db.Date columns are UTC midnight. Built from local time they shift by a day.
  it('날짜를 UTC 자정으로 맞춘다', async () => {
    const prisma = buildPrisma();
    const service = await buildService(prisma);

    await service.create('res-1', { ...DTO, dueDate: '2026-08-05' }, ACTOR);

    const created = prisma.reservationTrace.create.mock.calls[0][0].data;
    expect(created.dueDate.toISOString()).toBe('2026-08-05T00:00:00.000Z');
  });

  it('잘못된 지시는 BadRequest 로 낸다', async () => {
    const prisma = buildPrisma();
    const service = await buildService(prisma);

    await expect(
      service.create('res-1', { ...DTO, dueDate: '2026-09-01' }, ACTOR),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
