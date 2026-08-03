import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  Prisma,
  SyncDirection,
  SyncStatus,
  type Block,
  type BlockAllotment,
  type Property,
} from '@prisma/client';
import type { AuthUser } from '../auth/auth.constants';
import { CoreClient } from '../core/core.client';
import type { CoreBlock } from '../core/core.types';
import { PrismaService } from '../prisma/prisma.service';
import { assertWithinScope, resolvePropertyScope } from '../properties/property-scope';
import { parseDateOnly } from '../sync/reservation.mapper';
import { toBlockStatus, toCoreBlockStatus } from './block.mapper';
import type { CreateBlockDto, ListBlocksDto, UpdateBlockDto } from './dto/blocks.dto';

type BlockWithAllotments = Block & { allotments: BlockAllotment[] };

/**
 * 단체 블록.
 *
 * 블록은 일반 판매와 같은 재고 풀을 미리 잡아 두는 장치다. PlanForge 가 따로
 * 재고를 계산하면 단체 할당과 일반 판매가 서로 다른 숫자를 보게 되어 오버북이
 * 난다. 그래서 예약과 마찬가지로 OPERA 를 원천으로 두고 결과만 미러링한다.
 */
@Injectable()
export class BlocksService {
  private readonly logger = new Logger(BlocksService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly core: CoreClient,
  ) {}

  async list(query: ListBlocksDto, user: AuthUser): Promise<BlockWithAllotments[]> {
    const property = await this.resolveProperty(query.propertyId, user);

    const result = await this.core.listBlocks({
      hotelId: property.operaHotelId,
      status: query.status ? toCoreBlockStatus(query.status) : undefined,
      startFrom: query.startFrom,
      limit: 200,
    });

    for (const block of result.items) {
      await this.mirror(property, block);
    }

    return this.prisma.block.findMany({
      where: {
        propertyId: property.id,
        ...(query.status ? { status: query.status } : {}),
        ...(query.startFrom ? { endDate: { gte: parseDateOnly(query.startFrom) } } : {}),
      },
      include: { allotments: { orderBy: [{ date: 'asc' }, { roomTypeCode: 'asc' }] } },
      orderBy: { startDate: 'asc' },
    });
  }

  /** 단건은 항상 OPERA 에서 다시 읽는다. 픽업 수치는 로컬 캐시보다 원천이 정확하다. */
  async get(id: string, user: AuthUser): Promise<BlockWithAllotments> {
    const { block, property } = await this.loadLinked(id, user);
    const fresh = await this.core.getBlock(block.operaBlockId!);
    return this.mirror(property, fresh);
  }

  /** 룸리스트 — 이 블록에서 빠져나간 예약. */
  async roomingList(id: string, user: AuthUser) {
    const { block } = await this.loadLinked(id, user);
    const result = await this.core.listBlockReservations(block.operaBlockId!);
    return { blockId: block.id, code: block.code, items: result.items };
  }

  async create(dto: CreateBlockDto, user: AuthUser): Promise<BlockWithAllotments> {
    const property = await this.resolveProperty(dto.propertyId, user);
    this.assertDateRange(dto.startDate, dto.endDate, dto.cutoffDate);

    const code = dto.code.toUpperCase();
    const log = await this.startLog(null, { action: 'create', code, hotelId: property.operaHotelId });

    try {
      const created = await this.core.createBlock({
        hotelId: property.operaHotelId,
        code,
        name: dto.name,
        startDate: dto.startDate,
        endDate: dto.endDate,
        cutoffDate: dto.cutoffDate,
        status: dto.status ? toCoreBlockStatus(dto.status) : undefined,
        allotments: dto.allotments.map((slot) => ({
          roomTypeCode: slot.roomTypeCode.toUpperCase(),
          blocked: slot.blocked,
          ratePlanCode: slot.ratePlanCode,
        })),
      });

      const mirrored = await this.mirror(property, created);
      await this.finishLog(log.id, SyncStatus.SUCCESS, created.blockId);
      return mirrored;
    } catch (error) {
      await this.finishLog(log.id, SyncStatus.FAILED, null, error);
      throw error;
    }
  }

  async update(id: string, dto: UpdateBlockDto, user: AuthUser): Promise<BlockWithAllotments> {
    const { block, property } = await this.loadLinked(id, user);

    if (dto.cutoffDate) {
      // 컷오프가 시작일보다 뒤면 아무것도 풀지 않는다는 뜻이라 설정 자체가 무의미하다.
      const start = block.startDate.toISOString().slice(0, 10);
      if (dto.cutoffDate > start) {
        throw new BadRequestException('컷오프 날짜는 블록 시작일보다 앞이어야 합니다.');
      }
    }

    const log = await this.startLog(block.operaBlockId, { action: 'update', ...dto });

    try {
      const updated = await this.core.updateBlock(block.operaBlockId!, {
        name: dto.name,
        status: dto.status ? toCoreBlockStatus(dto.status) : undefined,
        cutoffDate: dto.cutoffDate,
      });

      const mirrored = await this.mirror(property, updated);
      await this.finishLog(log.id, SyncStatus.SUCCESS, updated.blockId);
      return mirrored;
    } catch (error) {
      await this.finishLog(log.id, SyncStatus.FAILED, block.operaBlockId, error);
      throw error;
    }
  }

  // ---------------------------------------------------------------------------

  /**
   * OPERA 결과를 로컬에 반영한다.
   *
   * 할당은 부분 갱신하지 않고 통째로 다시 쓴다. OPERA 가 일자나 객실 타입을
   * 줄였을 때 남은 행을 지우지 않으면 화면에 유령 할당이 계속 보이기 때문이다.
   */
  private async mirror(property: Property, source: CoreBlock): Promise<BlockWithAllotments> {
    const data = {
      propertyId: property.id,
      code: source.code,
      name: source.name,
      status: toBlockStatus(source.status),
      startDate: parseDateOnly(source.startDate),
      endDate: parseDateOnly(source.endDate),
      cutoffDate: source.cutoffDate ? parseDateOnly(source.cutoffDate) : null,
      currency: source.currency ?? property.currency,
      totalBlocked: source.totalBlocked,
      totalPickedUp: source.totalPickedUp,
    };

    return this.prisma.$transaction(async (tx) => {
      const block = await tx.block.upsert({
        where: { operaBlockId: source.blockId },
        update: data,
        create: { ...data, operaBlockId: source.blockId },
      });

      await tx.blockAllotment.deleteMany({ where: { blockId: block.id } });
      if (source.allotments.length > 0) {
        await tx.blockAllotment.createMany({
          data: source.allotments.map((slot) => ({
            blockId: block.id,
            date: parseDateOnly(slot.date),
            roomTypeCode: slot.roomTypeCode,
            blocked: slot.blocked,
            pickedUp: slot.pickedUp,
            ratePlanCode: slot.ratePlanCode ?? null,
            amount: slot.amount === undefined ? null : new Prisma.Decimal(slot.amount),
          })),
        });
      }

      const allotments = await tx.blockAllotment.findMany({
        where: { blockId: block.id },
        orderBy: [{ date: 'asc' }, { roomTypeCode: 'asc' }],
      });

      return { ...block, allotments };
    });
  }

  private async loadLinked(id: string, user: AuthUser) {
    const block = await this.prisma.block.findUnique({ where: { id }, include: { property: true } });
    if (!block) {
      throw new NotFoundException(`블록을 찾을 수 없습니다: ${id}`);
    }
    assertWithinScope(user, block.propertyId);

    // OPERA 에 없는 블록은 여기서 고칠 수 없다. 로컬만 바꾸면 두 쪽이 갈린다.
    if (!block.operaBlockId) {
      throw new BadRequestException(
        'OPERA 와 연결되지 않은 블록입니다. 먼저 동기화한 뒤 다시 시도해 주세요.',
      );
    }

    return { block, property: block.property };
  }

  private async resolveProperty(requested: string | undefined, user: AuthUser): Promise<Property> {
    const propertyId = resolvePropertyScope(user, requested);
    if (!propertyId) {
      throw new BadRequestException('호텔을 선택해 주세요.');
    }

    const property = await this.prisma.property.findUnique({ where: { id: propertyId } });
    if (!property) {
      throw new NotFoundException(`호텔을 찾을 수 없습니다: ${propertyId}`);
    }
    return property;
  }

  private assertDateRange(start: string, end: string, cutoff?: string): void {
    if (end <= start) {
      throw new BadRequestException('종료일은 시작일보다 뒤여야 합니다.');
    }
    // 컷오프가 시작일 이후면 풀 시점이 이미 지난 것이라 아무 효과가 없다.
    if (cutoff && cutoff > start) {
      throw new BadRequestException('컷오프 날짜는 블록 시작일보다 앞이어야 합니다.');
    }
  }

  private startLog(entityId: string | null, payload: unknown) {
    return this.prisma.syncLog.create({
      data: {
        entity: 'Block',
        entityId,
        direction: SyncDirection.PUSH,
        status: SyncStatus.PENDING,
        payload: payload as Prisma.InputJsonValue,
      },
    });
  }

  private async finishLog(
    id: string,
    status: SyncStatus,
    entityId: string | null,
    error?: unknown,
  ): Promise<void> {
    const message = error instanceof Error ? error.message : error ? String(error) : null;
    if (message) {
      this.logger.warn(`OPERA 블록 쓰기 실패: ${message}`);
    }

    await this.prisma.syncLog.update({
      where: { id },
      data: {
        status,
        finishedAt: new Date(),
        ...(entityId ? { entityId } : {}),
        ...(message ? { error: message } : {}),
      },
    });
  }
}
