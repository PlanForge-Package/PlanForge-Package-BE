import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../prisma/prisma.service';
import type { JwtPayload } from './auth.constants';
import type { AuthUserDto, LoginDto, LoginResponseDto } from './dto/auth.dto';

/**
 * 존재하지 않는 계정에도 해싱 비용을 치르기 위한 더미 해시.
 *
 * 없는 이메일이면 즉시 반환하고 있는 이메일이면 bcrypt 를 도는 구현은 응답
 * 시간 차이로 계정 존재 여부가 새어 나간다.
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

    // 아이디 없음·비밀번호 틀림·비활성 계정을 같은 문구로 돌려준다.
    // 어느 쪽이 틀렸는지 알려주면 계정 열거에 쓰인다.
    if (!user || !matches || !user.active) {
      this.logger.warn(`로그인 실패: ${email}`);
      throw new UnauthorizedException('이메일 또는 비밀번호가 올바르지 않습니다.');
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

  /** 토큰이 가리키는 계정이 아직 유효한지 다시 확인해 돌려준다. */
  async me(userId: string): Promise<AuthUserDto> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });

    // 토큰 발급 후 계정이 지워지거나 비활성화될 수 있다. 토큰만 믿지 않는다.
    if (!user || !user.active) {
      throw new UnauthorizedException('사용할 수 없는 계정입니다. 다시 로그인해 주세요.');
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

/** `8h`·`30m`·`7d` 같은 표기를 밀리초로. 알 수 없으면 8시간. */
function parseDuration(value: string): number {
  const match = /^(\d+)([smhd])$/.exec(value.trim());
  if (!match) return 8 * 60 * 60 * 1000;

  const amount = Number(match[1]);
  const unit = match[2] as 's' | 'm' | 'h' | 'd';
  const factor = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[unit];
  return amount * factor;
}
