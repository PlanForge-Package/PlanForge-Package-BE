import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, UserRole, type User } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../prisma/prisma.service';
import type { CreateUserDto, ListUsersDto, ResetPasswordDto, UpdateUserDto } from './dto/users.dto';

const BCRYPT_ROUNDS = 10;

/** 응답에서 항상 제외할 필드. 해시는 어떤 경로로도 밖에 나가지 않는다. */
const PUBLIC_FIELDS = {
  id: true,
  email: true,
  name: true,
  role: true,
  propertyId: true,
  active: true,
  lastLoginAt: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.UserSelect;

export type PublicUser = Prisma.UserGetPayload<{ select: typeof PUBLIC_FIELDS }>;

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  async list(query: ListUsersDto) {
    const { role, includeInactive = false, q, limit = 50, offset = 0 } = query;

    const where: Prisma.UserWhereInput = {
      ...(role ? { role } : {}),
      ...(includeInactive ? {} : { active: true }),
      ...(q
        ? {
            OR: [
              { name: { contains: q, mode: Prisma.QueryMode.insensitive } },
              { email: { contains: q, mode: Prisma.QueryMode.insensitive } },
            ],
          }
        : {}),
    };

    const [items, total] = await Promise.all([
      this.prisma.user.findMany({
        where,
        select: PUBLIC_FIELDS,
        orderBy: [{ active: 'desc' }, { name: 'asc' }],
        take: limit,
        skip: offset,
      }),
      this.prisma.user.count({ where }),
    ]);

    return { items, total, limit, offset };
  }

  async findOne(id: string): Promise<PublicUser> {
    const user = await this.prisma.user.findUnique({ where: { id }, select: PUBLIC_FIELDS });
    if (!user) {
      throw new NotFoundException(`계정을 찾을 수 없습니다: ${id}`);
    }
    return user;
  }

  async create(dto: CreateUserDto): Promise<PublicUser> {
    await this.assertPropertyExists(dto.propertyId);

    const passwordHash = await bcrypt.hash(dto.password, BCRYPT_ROUNDS);

    try {
      return await this.prisma.user.create({
        data: {
          email: dto.email,
          name: dto.name.trim(),
          passwordHash,
          role: dto.role,
          propertyId: dto.propertyId || null,
        },
        select: PUBLIC_FIELDS,
      });
    } catch (error) {
      // 이메일 중복은 사용자가 고칠 수 있는 문제다. 500 으로 흘리지 않는다.
      if (isUniqueViolation(error, 'email')) {
        throw new ConflictException('이미 사용 중인 이메일입니다.');
      }
      throw error;
    }
  }

  /**
   * 계정 수정.
   *
   * 스스로를 잠그는 조합과 마지막 관리자를 잃는 조합을 막는다. 둘 다 복구하려면
   * DB 를 직접 건드려야 해서, 잘못 눌렀을 때 대가가 크다.
   */
  async update(id: string, dto: UpdateUserDto, actorId: string): Promise<PublicUser> {
    const target = await this.prisma.user.findUnique({ where: { id } });
    if (!target) {
      throw new NotFoundException(`계정을 찾을 수 없습니다: ${id}`);
    }

    const isSelf = target.id === actorId;

    if (isSelf && dto.active === false) {
      throw new BadRequestException('자기 계정은 비활성화할 수 없습니다.');
    }
    if (isSelf && dto.role !== undefined && dto.role !== target.role) {
      throw new BadRequestException('자기 역할은 변경할 수 없습니다. 다른 관리자에게 요청하세요.');
    }

    const losesAdmin =
      target.role === UserRole.ADMIN &&
      ((dto.role !== undefined && dto.role !== UserRole.ADMIN) || dto.active === false);

    if (losesAdmin && (await this.countActiveAdmins()) <= 1) {
      throw new BadRequestException(
        '마지막 관리자입니다. 다른 관리자를 먼저 지정한 뒤 변경하세요.',
      );
    }

    if (dto.propertyId !== undefined && dto.propertyId !== '') {
      await this.assertPropertyExists(dto.propertyId);
    }

    return this.prisma.user.update({
      where: { id },
      data: {
        ...(dto.name === undefined ? {} : { name: dto.name.trim() }),
        ...(dto.role === undefined ? {} : { role: dto.role }),
        ...(dto.active === undefined ? {} : { active: dto.active }),
        // 빈 문자열은 "소속 없음(본사)" 으로 읽는다.
        ...(dto.propertyId === undefined ? {} : { propertyId: dto.propertyId || null }),
      },
      select: PUBLIC_FIELDS,
    });
  }

  /** 관리자가 남의 비밀번호를 초기화한다. 현재 비밀번호는 묻지 않는다. */
  async resetPassword(id: string, dto: ResetPasswordDto): Promise<{ ok: true }> {
    const user = await this.prisma.user.findUnique({ where: { id }, select: { id: true } });
    if (!user) {
      throw new NotFoundException(`계정을 찾을 수 없습니다: ${id}`);
    }

    await this.prisma.user.update({
      where: { id },
      data: { passwordHash: await bcrypt.hash(dto.password, BCRYPT_ROUNDS) },
    });

    return { ok: true };
  }

  /**
   * 본인이 비밀번호를 바꾼다.
   *
   * 현재 비밀번호를 반드시 확인한다 — 자리를 비운 사이 남이 세션을 잡으면
   * 확인 없이는 비밀번호를 갈아 끼워 계정을 통째로 뺏을 수 있다.
   */
  async changeOwnPassword(
    userId: string,
    currentPassword: string,
    newPassword: string,
  ): Promise<{ ok: true }> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException('계정을 찾을 수 없습니다.');
    }

    if (!(await bcrypt.compare(currentPassword, user.passwordHash))) {
      throw new BadRequestException('현재 비밀번호가 올바르지 않습니다.');
    }
    if (await bcrypt.compare(newPassword, user.passwordHash)) {
      throw new BadRequestException('새 비밀번호가 현재 비밀번호와 같습니다.');
    }

    await this.prisma.user.update({
      where: { id: userId },
      data: { passwordHash: await bcrypt.hash(newPassword, BCRYPT_ROUNDS) },
    });

    return { ok: true };
  }

  private countActiveAdmins(): Promise<number> {
    return this.prisma.user.count({ where: { role: UserRole.ADMIN, active: true } });
  }

  private async assertPropertyExists(propertyId?: string): Promise<void> {
    if (!propertyId) return;

    const property = await this.prisma.property.findUnique({
      where: { id: propertyId },
      select: { id: true },
    });
    if (!property) {
      throw new BadRequestException(`호텔을 찾을 수 없습니다: ${propertyId}`);
    }
  }
}

/**
 * Prisma 고유 제약 위반(P2002)인지 확인한다.
 *
 * `meta.target` 은 믿을 수 없다 — Prisma 6.19 는 필드명 대신 "(not available)" 을
 * 주는 경우가 있어, 이름 매칭만 하면 위반을 놓치고 500 이 나간다. 값이 있으면
 * 필드를 대조하고, 없으면 P2002 자체를 근거로 삼는다. User 에 걸린 고유 제약은
 * email 하나뿐이라 오판할 여지가 없다.
 */
function isUniqueViolation(error: unknown, field: keyof User): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
    return false;
  }

  const target = error.meta?.target;
  if (typeof target === 'string') return target.includes(field);
  if (Array.isArray(target)) return target.some((t) => String(t).includes(field));

  return true;
}
