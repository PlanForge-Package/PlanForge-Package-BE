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

  // 객실 상태 변경은 OPERA 위임이 필요해 HousekeepingService 로 옮겼다.

  /** 객실 상태별 집계. 하우스키핑 보드용. */
  async statusSummary(requestedPropertyId: string, user: AuthUser) {
    const propertyId = resolvePropertyScope(user, requestedPropertyId);

    // 집계는 호텔을 특정해야 의미가 있다. 전 호텔 합계는 운영에 쓸 일이 없다.
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
