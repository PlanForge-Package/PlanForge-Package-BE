import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { AuthUser } from '../auth/auth.constants';
import { PrismaService } from '../prisma/prisma.service';
import type { CreatePropertyDto, UpdatePropertyDto } from './dto/properties.dto';
import { assertWithinScope } from './property-scope';
import { isUniqueViolation } from '../common/prisma-errors';

@Injectable()
export class PropertiesService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Hotels the requester may see.
   *
   * Accounts with a property get only their own. Another hotel's name in the picker
   * reveals the org structure, and there is no reason to show unselectable options.
   */
  list(user: AuthUser, includeInactive = false) {
    return this.prisma.property.findMany({
      where: {
        ...(user.propertyId ? { id: user.propertyId } : {}),
        ...(includeInactive ? {} : { active: true }),
      },
      orderBy: [{ active: 'desc' }, { name: 'asc' }],
    });
  }

  async findOne(id: string) {
    const property = await this.prisma.property.findUnique({ where: { id } });
    if (!property) {
      throw new NotFoundException(`호텔을 찾을 수 없습니다: ${id}`);
    }
    return property;
  }

  /**
   * Room types of a hotel.
   *
   * Many places, like block allotments and inventory, only need "which types exist
   * here". Fetching every room and de-duplicating ships hundreds of rows for nothing.
   */
  async listRoomTypes(id: string, user: AuthUser) {
    await this.findOne(id);
    assertWithinScope(user, id);

    return this.prisma.roomType.findMany({
      where: { propertyId: id },
      select: { id: true, code: true, name: true, maxOccupancy: true },
      orderBy: { code: 'asc' },
    });
  }

  async create(dto: CreatePropertyDto) {
    try {
      return await this.prisma.property.create({
        data: {
          operaHotelId: dto.operaHotelId.trim(),
          name: dto.name.trim(),
          timezone: dto.timezone ?? 'Asia/Seoul',
          currency: dto.currency ?? 'KRW',
          address: dto.address?.trim() || null,
        },
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictException('이미 등록된 OPERA 호텔 코드입니다.');
      }
      throw error;
    }
  }

  async update(id: string, dto: UpdatePropertyDto) {
    await this.findOne(id);

    return this.prisma.property.update({
      where: { id },
      data: {
        ...(dto.name === undefined ? {} : { name: dto.name.trim() }),
        ...(dto.timezone === undefined ? {} : { timezone: dto.timezone }),
        ...(dto.currency === undefined ? {} : { currency: dto.currency }),
        ...(dto.address === undefined ? {} : { address: dto.address.trim() || null }),
        ...(dto.active === undefined ? {} : { active: dto.active }),
      },
    });
  }
}

/**
 * Checks whether this is a Prisma unique constraint violation (P2002).
 *
 * meta.target cannot be trusted — Prisma 6.19 sometimes gives "(not available)"
 * instead of field names. Property has exactly one unique constraint, operaHotelId,
 * so relying on P2002 itself misjudges nothing.
 */
