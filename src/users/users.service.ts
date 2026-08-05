import { Injectable } from '@nestjs/common';
import { Prisma, UserRole } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../prisma/prisma.service';
import type { CreateUserDto, ListUsersDto, ResetPasswordDto, UpdateUserDto } from './dto/users.dto';
import { isUniqueViolation } from '../common/prisma-errors';
import { badRequest, conflict, notFound } from '../common/errors';

const BCRYPT_ROUNDS = 10;

/** Fields always excluded from responses. The hash never leaves by any path. */
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
      throw notFound('USER_NOT_FOUND', { id: id });
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
      // A duplicate email is something the user can fix. It is not leaked as a 500.
      if (isUniqueViolation(error, 'email')) {
        throw conflict('USER_EMAIL_TAKEN');
      }
      throw error;
    }
  }

  /**
   * Account update.
   *
   * Blocks locking yourself out and losing the last admin. Recovering from either
   * means editing the database by hand, so a wrong click is expensive.
   */
  async update(id: string, dto: UpdateUserDto, actorId: string): Promise<PublicUser> {
    const target = await this.prisma.user.findUnique({ where: { id } });
    if (!target) {
      throw notFound('USER_NOT_FOUND', { id: id });
    }

    const isSelf = target.id === actorId;

    if (isSelf && dto.active === false) {
      throw badRequest('USER_SELF_DEACTIVATE');
    }
    if (isSelf && dto.role !== undefined && dto.role !== target.role) {
      throw badRequest('USER_SELF_ROLE');
    }

    const losesAdmin =
      target.role === UserRole.ADMIN &&
      ((dto.role !== undefined && dto.role !== UserRole.ADMIN) || dto.active === false);

    if (losesAdmin && (await this.countActiveAdmins()) <= 1) {
      throw badRequest('USER_LAST_ADMIN');
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
        // An empty string reads as "no property (head office)".
        ...(dto.propertyId === undefined ? {} : { propertyId: dto.propertyId || null }),
      },
      select: PUBLIC_FIELDS,
    });
  }

  /** An admin resets someone else's password. The current one is not asked for. */
  async resetPassword(id: string, dto: ResetPasswordDto): Promise<{ ok: true }> {
    const user = await this.prisma.user.findUnique({ where: { id }, select: { id: true } });
    if (!user) {
      throw notFound('USER_NOT_FOUND', { id: id });
    }

    await this.prisma.user.update({
      where: { id },
      data: { passwordHash: await bcrypt.hash(dto.password, BCRYPT_ROUNDS) },
    });

    return { ok: true };
  }

  /**
   * A user changes their own password.
   *
   * The current password is always verified — someone taking an unattended session
   * could otherwise swap the password and take the account outright.
   */
  async changeOwnPassword(
    userId: string,
    currentPassword: string,
    newPassword: string,
  ): Promise<{ ok: true }> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw notFound('USER_NOT_FOUND_PLAIN');
    }

    if (!(await bcrypt.compare(currentPassword, user.passwordHash))) {
      throw badRequest('USER_CURRENT_PASSWORD_WRONG');
    }
    if (await bcrypt.compare(newPassword, user.passwordHash)) {
      throw badRequest('USER_PASSWORD_UNCHANGED');
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
      throw badRequest('PROPERTY_NOT_FOUND', { propertyId: propertyId });
    }
  }
}

/**
 * Checks whether this is a Prisma unique constraint violation (P2002).
 *
 * `meta.target` cannot be trusted — Prisma 6.19 sometimes gives "(not available)"
 * instead of field names, so matching on names alone misses the violation and a 500
 * goes out. With a value we compare fields; without one, P2002 itself is the basis.
 * User has exactly one unique constraint, email, so there is nothing to misjudge.
 */
