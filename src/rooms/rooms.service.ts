import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, RoomStatus } from '@prisma/client';
import type { AuthUser } from '../auth/auth.constants';
import { PrismaService } from '../prisma/prisma.service';
import { assertWithinScope, resolvePropertyScope } from '../properties/property-scope';
import type { ListRoomsDto, UpdateRoomStatusDto } from './dto/rooms.dto';

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

  /**
   * 하우스키핑 상태 변경.
   *
   * 재실 중인 객실을 판매 불가로 돌리면 재고와 실제가 어긋나므로 막는다.
   */
  async updateStatus(id: string, dto: UpdateRoomStatusDto, user: AuthUser) {
    const room = await this.prisma.room.findUnique({ where: { id } });
    if (!room) {
      throw new NotFoundException(`객실을 찾을 수 없습니다: ${id}`);
    }
    assertWithinScope(user, room.propertyId);

    const blocking =
      dto.status === RoomStatus.OUT_OF_ORDER || dto.status === RoomStatus.OUT_OF_SERVICE;
    if (room.occupied && blocking) {
      throw new BadRequestException('재실 중인 객실은 판매 불가 상태로 변경할 수 없습니다.');
    }

    return this.prisma.room.update({ where: { id }, data: { status: dto.status } });
  }

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
