import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma, RoomStatus } from '@prisma/client';
import type { AuthUser } from '../auth/auth.constants';
import { PrismaService } from '../prisma/prisma.service';
import { resolvePropertyScope } from '../properties/property-scope';
import type { ListRoomsDto } from './dto/rooms.dto';

@Injectable()
export class RoomsService {
  constructor(private readonly prisma: PrismaService) {}

  list(query: ListRoomsDto, user: AuthUser) {
    const propertyId = resolvePropertyScope(user, query.propertyId);

    const where: Prisma.RoomWhereInput = {
      ...(propertyId ? { propertyId } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.occupied === undefined ? {} : { occupied: query.occupied }),
    };

    return this.prisma.room.findMany({
      where,
      include: { roomType: true },
      orderBy: [{ floor: 'asc' }, { number: 'asc' }],
    });
  }

  // Room status changes need delegation to OPERA and moved to HousekeepingService.

  /** Counts by room status, for the housekeeping board. */
  async statusSummary(requestedPropertyId: string, user: AuthUser) {
    const propertyId = resolvePropertyScope(user, requestedPropertyId);

    // Counts only mean something for one hotel. A chain-wide total has no operational use.
    if (!propertyId) {
      throw new BadRequestException('호텔을 선택해 주세요.');
    }

    const grouped = await this.prisma.room.groupBy({
      by: ['status'],
      where: { propertyId },
      _count: { _all: true },
    });

    const counts = Object.fromEntries(
      Object.values(RoomStatus).map((status) => [status, 0]),
    ) as Record<RoomStatus, number>;

    for (const row of grouped) {
      counts[row.status] = row._count._all;
    }

    const occupied = await this.prisma.room.count({ where: { propertyId, occupied: true } });
    const total = Object.values(counts).reduce((sum, value) => sum + value, 0);

    return { propertyId, total, occupied, vacant: total - occupied, byStatus: counts };
  }
}
