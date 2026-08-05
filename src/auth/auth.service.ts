import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../prisma/prisma.service';
import type { JwtPayload } from './auth.constants';
import type { AuthUserDto, LoginDto, LoginResponseDto } from './dto/auth.dto';
import { unauthorized } from '../common/errors';

/**
 * Dummy hash so a non-existent account still pays the hashing cost.
 *
 * Returning immediately for an unknown email and running bcrypt for a known one
 * leaks whether the account exists through the response time.
 */
const DUMMY_HASH = '$2b$10$abcdefghijklmnopqrstuvCq6XxKyPqQ5wZ0kY0RQ8pJZ0Yb0uK.';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  async login(dto: LoginDto): Promise<LoginResponseDto> {
    const email = dto.email.trim().toLowerCase();
    const user = await this.prisma.user.findUnique({ where: { email } });

    const matches = await bcrypt.compare(dto.password, user?.passwordHash ?? DUMMY_HASH);

    // Unknown email, wrong password and disabled account all return the same message.
    // Saying which one was wrong is what account enumeration runs on.
    if (!user || !matches || !user.active) {
      this.logger.warn(`Login failed: ${email}`);
      throw unauthorized('BAD_CREDENTIALS');
    }

    await this.prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });

    const payload: JwtPayload = {
      sub: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      propertyId: user.propertyId,
    };

    const accessToken = await this.jwt.signAsync(payload);
    const expiresIn = this.config.get<string>('JWT_EXPIRES_IN') ?? '8h';

    return {
      accessToken,
      expiresAt: new Date(Date.now() + parseDuration(expiresIn)).toISOString(),
      user: toAuthUser(user),
    };
  }

  /** Re-checks that the account the token names is still valid, and returns it. */
  async me(userId: string): Promise<AuthUserDto> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });

    // An account can be deleted or disabled after the token was issued. The token alone is not trusted.
    if (!user || !user.active) {
      throw unauthorized('ACCOUNT_DISABLED');
    }

    return toAuthUser(user);
  }
}

function toAuthUser(user: {
  id: string;
  email: string;
  name: string;
  role: AuthUserDto['role'];
  propertyId: string | null;
}): AuthUserDto {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    propertyId: user.propertyId,
  };
}

/** `8h`, `30m`, `7d` and the like to milliseconds. Unknown falls back to 8 hours. */
function parseDuration(value: string): number {
  const match = /^(\d+)([smhd])$/.exec(value.trim());
  if (!match) return 8 * 60 * 60 * 1000;

  const amount = Number(match[1]);
  const unit = match[2] as 's' | 'm' | 'h' | 'd';
  const factor = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[unit];
  return amount * factor;
}
