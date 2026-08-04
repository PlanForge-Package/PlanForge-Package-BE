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

/** Random bytes in a key. At 32 bytes, guessing is not realistically possible. */
const KEY_BYTES = 32;

/**
 * POS outlet management.
 *
 * A key exists in plaintext only at the moment it is issued. It is stored as a
 * bcrypt hash and cannot be shown again — a lost key is reissued. Making it
 * readable would turn a database leak into the theft of every terminal.
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

  /** Returns the plaintext key exactly once. The screen has to show it there and then. */
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
   * Key reissue.
   *
   * The previous key stops working immediately. It is used when a leak is suspected,
   * so a grace period would defeat it — the terminal has to be set up with the new key.
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
    // Reissuing another hotel's terminal key stops that hotel's outlets.
    resolvePropertyScope(user, outlet.propertyId);
    return outlet;
  }
}

/** The hash never leaves. The prefix alone is enough to tell which key it is. */
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
