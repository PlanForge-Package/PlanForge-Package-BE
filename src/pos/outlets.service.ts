import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, type PosOutlet } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { randomBytes } from 'node:crypto';
import type { AuthUser } from '../auth/auth.constants';
import { PrismaService } from '../prisma/prisma.service';
import { resolvePropertyScope } from '../properties/property-scope';
import { POS_KEY_PREFIX, POS_KEY_PREFIX_LENGTH } from './pos-key.guard';
import type { CreateOutletDto, UpdateOutletDto } from './dto/pos.dto';

/** 키에 담는 무작위 바이트 수. 32바이트면 추측이 현실적으로 불가능하다. */
const KEY_BYTES = 32;

/**
 * POS 아웃렛 관리.
 *
 * 키는 발급 순간에만 평문으로 존재한다. 저장은 bcrypt 해시로만 하므로 다시
 * 보여 줄 수 없다 — 잃어버리면 재발급이다. 다시 볼 수 있게 만들면 데이터베이스
 * 유출이 곧 모든 단말의 탈취가 된다.
 */
@Injectable()
export class OutletsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(requestedPropertyId: string | undefined, user: AuthUser) {
    const propertyId = resolvePropertyScope(user, requestedPropertyId);

    const items = await this.prisma.posOutlet.findMany({
      where: propertyId ? { propertyId } : {},
      orderBy: [{ active: 'desc' }, { code: 'asc' }],
    });

    return { items: items.map(toPublicOutlet) };
  }

  /** 발급한 평문 키를 딱 한 번 돌려준다. 화면이 그 자리에서 보여 줘야 한다. */
  async create(dto: CreateOutletDto, user: AuthUser) {
    const propertyId = resolvePropertyScope(user, dto.propertyId);
    if (!propertyId) {
      throw new BadRequestException('호텔을 선택해 주세요.');
    }

    const property = await this.prisma.property.findUnique({ where: { id: propertyId } });
    if (!property) {
      throw new NotFoundException(`호텔을 찾을 수 없습니다: ${propertyId}`);
    }

    const { key, hash, prefix } = await issueKey();

    try {
      const outlet = await this.prisma.posOutlet.create({
        data: {
          propertyId,
          code: dto.code,
          name: dto.name.trim(),
          transactionCode: dto.transactionCode,
          apiKeyHash: hash,
          apiKeyPrefix: prefix,
        },
      });
      return { outlet: toPublicOutlet(outlet), apiKey: key };
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictException(`이미 등록된 아웃렛 코드입니다: ${dto.code}`);
      }
      throw error;
    }
  }

  async update(id: string, dto: UpdateOutletDto, user: AuthUser) {
    const outlet = await this.load(id, user);

    const updated = await this.prisma.posOutlet.update({
      where: { id: outlet.id },
      data: {
        ...(dto.name === undefined ? {} : { name: dto.name.trim() }),
        ...(dto.transactionCode === undefined ? {} : { transactionCode: dto.transactionCode }),
        ...(dto.active === undefined ? {} : { active: dto.active }),
      },
    });

    return toPublicOutlet(updated);
  }

  /**
   * 키 재발급.
   *
   * 이전 키는 즉시 통하지 않는다. 유출이 의심될 때 쓰는 기능이라 유예를 두면
   * 의미가 없다 — 단말은 새 키로 다시 설정해야 한다.
   */
  async rotateKey(id: string, user: AuthUser) {
    const outlet = await this.load(id, user);
    const { key, hash, prefix } = await issueKey();

    const updated = await this.prisma.posOutlet.update({
      where: { id: outlet.id },
      data: { apiKeyHash: hash, apiKeyPrefix: prefix, keyIssuedAt: new Date() },
    });

    return { outlet: toPublicOutlet(updated), apiKey: key };
  }

  private async load(id: string, user: AuthUser): Promise<PosOutlet> {
    const outlet = await this.prisma.posOutlet.findUnique({ where: { id } });
    if (!outlet) {
      throw new NotFoundException(`아웃렛을 찾을 수 없습니다: ${id}`);
    }
    // 다른 호텔의 단말 키를 재발급하면 그 호텔의 매장이 멈춘다.
    resolvePropertyScope(user, outlet.propertyId);
    return outlet;
  }
}

/** 해시는 절대 내보내지 않는다. 앞자리만 있으면 어느 키인지 알아볼 수 있다. */
function toPublicOutlet(outlet: PosOutlet) {
  return {
    id: outlet.id,
    propertyId: outlet.propertyId,
    code: outlet.code,
    name: outlet.name,
    transactionCode: outlet.transactionCode,
    apiKeyPrefix: outlet.apiKeyPrefix,
    keyIssuedAt: outlet.keyIssuedAt,
    active: outlet.active,
    lastUsedAt: outlet.lastUsedAt,
    createdAt: outlet.createdAt,
  };
}

async function issueKey(): Promise<{ key: string; hash: string; prefix: string }> {
  const key = `${POS_KEY_PREFIX}${randomBytes(KEY_BYTES).toString('base64url')}`;
  return {
    key,
    hash: await bcrypt.hash(key, 10),
    prefix: key.slice(0, POS_KEY_PREFIX_LENGTH),
  };
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}
