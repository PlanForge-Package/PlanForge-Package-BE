import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { BlockStatus, SyncStatus, UserRole } from '@prisma/client';
import type { AuthUser } from '../auth/auth.constants';
import { CoreClient } from '../core/core.client';
import type { CoreBlock } from '../core/core.types';
import { PrismaService } from '../prisma/prisma.service';
import { BlocksService } from './blocks.service';

const PROPERTY = {
  id: 'prop-1',
  operaHotelId: 'SAND01',
  name: 'PlanForge Seoul',
  currency: 'KRW',
};

const HQ: AuthUser = {
  id: 'u1',
  sub: 'u1',
  email: 'a@b.c',
  name: '본사',
  role: UserRole.MANAGER,
  propertyId: null,
};

const OPERA_BLOCK: CoreBlock = {
  blockId: 'BLK-501',
  code: 'SPGRP',
  name: '스페이스플래닝 워크숍',
  hotelId: 'SAND01',
  status: 'Definite',
  startDate: '2026-09-01',
  endDate: '2026-09-03',
  cutoffDate: '2026-08-25',
  currency: 'KRW',
  allotments: [
    { date: '2026-09-01', roomTypeCode: 'STDT', blocked: 10, pickedUp: 3, ratePlanCode: 'CORP' },
    { date: '2026-09-02', roomTypeCode: 'STDT', blocked: 10, pickedUp: 2, ratePlanCode: 'CORP' },
  ],
  totalBlocked: 20,
  totalPickedUp: 5,
};

const LOCAL_BLOCK = {
  id: 'blk-1',
  operaBlockId: 'BLK-501',
  propertyId: 'prop-1',
  code: 'SPGRP',
  startDate: new Date(Date.UTC(2026, 8, 1)),
  property: PROPERTY,
};

function buildPrisma() {
  const tx = {
    block: {
      upsert: jest.fn().mockResolvedValue({ id: 'blk-1', code: 'SPGRP' }),
    },
    blockAllotment: {
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      createMany: jest.fn().mockResolvedValue({ count: 2 }),
      findMany: jest.fn().mockResolvedValue([]),
    },
  };

  return {
    tx,
    property: { findUnique: jest.fn().mockResolvedValue(PROPERTY) },
    block: {
      findUnique: jest.fn().mockResolvedValue(LOCAL_BLOCK),
      findMany: jest.fn().mockResolvedValue([]),
    },
    syncLog: { create: jest.fn().mockResolvedValue({ id: 'log-1' }), update: jest.fn() },
    $transaction: jest.fn((fn: (t: typeof tx) => unknown) => fn(tx)),
  };
}

function buildCore() {
  return {
    listBlocks: jest.fn().mockResolvedValue({ items: [OPERA_BLOCK], limit: 200, offset: 0 }),
    getBlock: jest.fn().mockResolvedValue(OPERA_BLOCK),
    createBlock: jest.fn().mockResolvedValue(OPERA_BLOCK),
    updateBlock: jest.fn().mockResolvedValue(OPERA_BLOCK),
    listBlockReservations: jest.fn().mockResolvedValue({ items: [], limit: 200, offset: 0 }),
  };
}

async function buildService(
  prisma: ReturnType<typeof buildPrisma>,
  core: ReturnType<typeof buildCore>,
) {
  const moduleRef = await Test.createTestingModule({
    providers: [
      BlocksService,
      { provide: PrismaService, useValue: prisma },
      { provide: CoreClient, useValue: core },
    ],
  }).compile();
  return moduleRef.get(BlocksService);
}

const VALID_INPUT = {
  propertyId: 'prop-1',
  code: 'spgrp',
  name: '스페이스플래닝 워크숍',
  startDate: '2026-09-01',
  endDate: '2026-09-03',
  cutoffDate: '2026-08-25',
  allotments: [{ roomTypeCode: 'stdt', blocked: 10, ratePlanCode: 'CORP' }],
};

describe('BlocksService — 생성', () => {
  it('OPERA 에 만들고 돌아온 결과를 미러링한다', async () => {
    const prisma = buildPrisma();
    const core = buildCore();
    const service = await buildService(prisma, core);

    await service.create(VALID_INPUT, HQ);

    expect(core.createBlock).toHaveBeenCalledWith(
      expect.objectContaining({ hotelId: 'SAND01', code: 'SPGRP' }),
    );
    const upsert = prisma.tx.block.upsert.mock.calls[0][0];
    expect(upsert.where).toEqual({ operaBlockId: 'BLK-501' });
  });

  // 코드는 예약할 때 그대로 입력하는 값이다. 대소문자가 섞이면 같은 블록을 못 찾는다.
  it('블록 코드와 객실 타입 코드를 대문자로 맞춰 보낸다', async () => {
    const prisma = buildPrisma();
    const core = buildCore();
    const service = await buildService(prisma, core);

    await service.create(VALID_INPUT, HQ);

    const sent = core.createBlock.mock.calls[0][0];
    expect(sent.code).toBe('SPGRP');
    expect(sent.allotments[0].roomTypeCode).toBe('STDT');
  });

  // 우리가 보낸 값이 아니라 OPERA 가 확정한 값을 적어야 두 쪽이 갈리지 않는다.
  it('로컬에는 OPERA 가 돌려준 상태와 합계를 적는다', async () => {
    const prisma = buildPrisma();
    const core = buildCore();
    core.createBlock.mockResolvedValue({
      ...OPERA_BLOCK,
      status: 'Tentative' as const,
      totalPickedUp: 7,
    });
    const service = await buildService(prisma, core);

    await service.create({ ...VALID_INPUT, status: BlockStatus.DEFINITE }, HQ);

    const upsert = prisma.tx.block.upsert.mock.calls[0][0];
    expect(upsert.create.status).toBe(BlockStatus.TENTATIVE);
    expect(upsert.create.totalPickedUp).toBe(7);
  });

  it('종료일이 시작일보다 앞서면 OPERA 를 호출하지 않는다', async () => {
    const prisma = buildPrisma();
    const core = buildCore();
    const service = await buildService(prisma, core);

    await expect(
      service.create({ ...VALID_INPUT, startDate: '2026-09-03', endDate: '2026-09-01' }, HQ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(core.createBlock).not.toHaveBeenCalled();
  });

  // 컷오프가 시작일 뒤면 풀 시점이 이미 지나 아무 효과가 없다.
  it('컷오프가 시작일보다 뒤면 거절한다', async () => {
    const prisma = buildPrisma();
    const core = buildCore();
    const service = await buildService(prisma, core);

    await expect(
      service.create({ ...VALID_INPUT, cutoffDate: '2026-09-02' }, HQ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(core.createBlock).not.toHaveBeenCalled();
  });

  it('OPERA 가 거절하면 실패 이력을 남기고 그대로 올린다', async () => {
    const prisma = buildPrisma();
    const core = buildCore();
    core.createBlock.mockRejectedValue(new Error('중복 코드'));
    const service = await buildService(prisma, core);

    await expect(service.create(VALID_INPUT, HQ)).rejects.toThrow('중복 코드');
    expect(prisma.syncLog.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: SyncStatus.FAILED }),
      }),
    );
  });
});

describe('BlocksService — 미러링', () => {
  // OPERA 가 일자나 객실 타입을 줄였을 때 남은 행을 지우지 않으면 유령 할당이 남는다.
  it('할당은 부분 갱신하지 않고 통째로 다시 쓴다', async () => {
    const prisma = buildPrisma();
    const core = buildCore();
    const service = await buildService(prisma, core);

    await service.get('blk-1', HQ);

    expect(prisma.tx.blockAllotment.deleteMany).toHaveBeenCalledWith({
      where: { blockId: 'blk-1' },
    });
    const created = prisma.tx.blockAllotment.createMany.mock.calls[0][0];
    expect(created.data).toHaveLength(2);
    expect(created.data[0]).toEqual(expect.objectContaining({ roomTypeCode: 'STDT', pickedUp: 3 }));
  });

  it('단건 조회는 로컬 캐시가 아니라 OPERA 를 다시 읽는다', async () => {
    const prisma = buildPrisma();
    const core = buildCore();
    const service = await buildService(prisma, core);

    await service.get('blk-1', HQ);

    expect(core.getBlock).toHaveBeenCalledWith('BLK-501');
  });
});

describe('BlocksService — 수정·룸리스트', () => {
  it('없는 블록은 404 로 알린다', async () => {
    const prisma = buildPrisma();
    prisma.block.findUnique.mockResolvedValue(null);
    const core = buildCore();
    const service = await buildService(prisma, core);

    await expect(service.get('nope', HQ)).rejects.toBeInstanceOf(NotFoundException);
  });

  // OPERA 에 없는 블록을 로컬만 바꾸면 두 쪽이 갈린다.
  it('OPERA 와 연결되지 않은 블록은 수정할 수 없다', async () => {
    const prisma = buildPrisma();
    prisma.block.findUnique.mockResolvedValue({ ...LOCAL_BLOCK, operaBlockId: null });
    const core = buildCore();
    const service = await buildService(prisma, core);

    await expect(service.update('blk-1', { name: '변경' }, HQ)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(core.updateBlock).not.toHaveBeenCalled();
  });

  it('상태 변경은 OPERA 표기로 바꿔 보낸다', async () => {
    const prisma = buildPrisma();
    const core = buildCore();
    const service = await buildService(prisma, core);

    await service.update('blk-1', { status: BlockStatus.DEFINITE }, HQ);

    expect(core.updateBlock).toHaveBeenCalledWith(
      'BLK-501',
      expect.objectContaining({ status: 'Definite' }),
    );
  });

  it('컷오프가 시작일보다 뒤면 수정도 거절한다', async () => {
    const prisma = buildPrisma();
    const core = buildCore();
    const service = await buildService(prisma, core);

    await expect(service.update('blk-1', { cutoffDate: '2026-09-05' }, HQ)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(core.updateBlock).not.toHaveBeenCalled();
  });

  it('룸리스트는 OPERA 블록 ID 로 조회한다', async () => {
    const prisma = buildPrisma();
    const core = buildCore();
    const service = await buildService(prisma, core);

    const result = await service.roomingList('blk-1', HQ);

    expect(core.listBlockReservations).toHaveBeenCalledWith('BLK-501');
    expect(result.code).toBe('SPGRP');
  });
});

describe('BlocksService — 다른 호텔 접근', () => {
  it('소속 호텔이 아니면 막는다', async () => {
    const prisma = buildPrisma();
    const core = buildCore();
    const service = await buildService(prisma, core);
    const other: AuthUser = { ...HQ, propertyId: 'prop-2' };

    await expect(service.get('blk-1', other)).rejects.toThrow(/접근할 수 없습니다/);
    expect(core.getBlock).not.toHaveBeenCalled();
  });
});
