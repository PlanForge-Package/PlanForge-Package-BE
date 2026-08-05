import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma, SyncStatus, type Block, type BlockAllotment, type Property } from '@prisma/client';
import type { AuthUser } from '../auth/auth.constants';
import { CoreClient } from '../core/core.client';
import type { CoreBlock } from '../core/core.types';
import { PrismaService } from '../prisma/prisma.service';
import { assertWithinScope, resolvePropertyScope } from '../properties/property-scope';
import { parseDateOnly } from '../sync/reservation.mapper';
import { toBlockStatus, toCoreBlockStatus } from './block.mapper';
import type { CreateBlockDto, ListBlocksDto, UpdateBlockDto } from './dto/blocks.dto';
import { finishSyncLog, startSyncLog } from '../sync/sync-log';

type BlockWithAllotments = Block & { allotments: BlockAllotment[] };

/**
 * Group blocks.
 *
 * A block reserves part of the same inventory pool that normal sales draw on.
 * Counting inventory separately in PlanForge would show group allotments and
 * transient sales different numbers and oversell. OPERA is the source; we mirror.
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

  /** A single block is always re-read from OPERA. Pickup counts beat the local cache. */
  async get(id: string, user: AuthUser): Promise<BlockWithAllotments> {
    const { block, property } = await this.loadLinked(id, user);
    const fresh = await this.core.getBlock(block.operaBlockId!);
    return this.mirror(property, fresh);
  }

  /** Rooming list — reservations picked up from this block. */
  async roomingList(id: string, user: AuthUser) {
    const { block } = await this.loadLinked(id, user);
    const result = await this.core.listBlockReservations(block.operaBlockId!);
    return { blockId: block.id, code: block.code, items: result.items };
  }

  async create(dto: CreateBlockDto, user: AuthUser): Promise<BlockWithAllotments> {
    const property = await this.resolveProperty(dto.propertyId, user);
    this.assertDateRange(dto.startDate, dto.endDate, dto.cutoffDate);

    const code = dto.code.toUpperCase();
    const log = await this.startLog(null, {
      action: 'create',
      code,
      hotelId: property.operaHotelId,
    });

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
          ratePlanCode: slot.ratePlanCode?.toUpperCase(),
          amount: slot.amount,
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
      // A cutoff after the start date releases nothing, making the setting meaningless.
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
        rates: dto.rates?.map((row) => ({
          roomTypeCode: row.roomTypeCode.toUpperCase(),
          ratePlanCode: row.ratePlanCode?.toUpperCase(),
          amount: row.amount,
        })),
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
   * Mirrors the OPERA result locally.
   *
   * Allotments are rewritten whole rather than patched. When OPERA drops a date or
   * room type, leftover rows would keep showing phantom allotments on the screen.
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
    const block = await this.prisma.block.findUnique({
      where: { id },
      include: { property: true },
    });
    if (!block) {
      throw new NotFoundException(`블록을 찾을 수 없습니다: ${id}`);
    }
    assertWithinScope(user, block.propertyId);

    // A block OPERA does not have cannot be fixed here; local-only diverges.
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
    // A cutoff after the start date has already passed its release point and does nothing.
    if (cutoff && cutoff > start) {
      throw new BadRequestException('컷오프 날짜는 블록 시작일보다 앞이어야 합니다.');
    }
  }

  private startLog(entityId: string | null, payload: unknown) {
    return startSyncLog(this.prisma, 'Block', entityId, payload);
  }

  private finishLog(
    id: string,
    status: SyncStatus,
    entityId: string | null,
    error?: unknown,
  ): Promise<void> {
    return finishSyncLog(this.prisma, id, status, {
      entityId,
      error,
      warn: (message) => this.logger.warn(`OPERA block write failed: ${message}`),
    });
  }
}
