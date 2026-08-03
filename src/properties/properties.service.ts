import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { AuthUser } from '../auth/auth.constants';
import { PrismaService } from '../prisma/prisma.service';
import type { CreatePropertyDto, UpdatePropertyDto } from './dto/properties.dto';
import { assertWithinScope } from './property-scope';

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

  /**
   * 호텔의 객실 타입.
   *
   * 블록 할당·재고 화면처럼 "이 호텔에 어떤 타입이 있는가" 만 필요한 곳이 많다.
   * 객실 전체를 받아 중복을 걷어내면 수백 행을 헛되이 실어 나른다.
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
 * Prisma 고유 제약 위반(P2002)인지 확인한다.
 *
 * meta.target 은 믿을 수 없다 — Prisma 6.19 는 필드명 대신 "(not available)" 을
 * 주는 경우가 있다. Property 의 고유 제약은 operaHotelId 하나뿐이라 P2002 자체를
 * 근거로 삼아도 오판하지 않는다.
 */
function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}
