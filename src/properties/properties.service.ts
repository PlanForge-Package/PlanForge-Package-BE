import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { AuthUser } from '../auth/auth.constants';
import { PrismaService } from '../prisma/prisma.service';
import type { CreatePropertyDto, UpdatePropertyDto } from './dto/properties.dto';

@Injectable()
export class PropertiesService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * 요청자가 볼 수 있는 호텔 목록.
   *
   * 소속이 있는 계정에는 자기 호텔만 준다. 선택기에 남의 호텔 이름이 뜨는 것만으로도
   * 조직 구조가 드러나고, 고를 수 없는 항목을 보여줄 이유도 없다.
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
 * Prisma 고유 제약 위반(P2002)인지 확인한다.
 *
 * meta.target 은 믿을 수 없다 — Prisma 6.19 는 필드명 대신 "(not available)" 을
 * 주는 경우가 있다. Property 의 고유 제약은 operaHotelId 하나뿐이라 P2002 자체를
 * 근거로 삼아도 오판하지 않는다.
 */
function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}
