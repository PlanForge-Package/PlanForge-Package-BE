import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsEmail,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

/** Minimum password length. The same value as the login DTO. */
export const MIN_PASSWORD_LENGTH = 8;

const normalizeEmail = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim().toLowerCase() : value;

export class CreateUserDto {
  @ApiProperty({ example: 'staff@planforge.local' })
  @Transform(normalizeEmail)
  @IsEmail({}, { message: '올바른 이메일 형식이 아닙니다.' })
  email!: string;

  @ApiProperty({ example: '홍길동' })
  @IsString()
  @MinLength(1, { message: '이름을 입력해 주세요.' })
  @MaxLength(60, { message: '이름은 60자 이하여야 합니다.' })
  name!: string;

  @ApiProperty({ minLength: MIN_PASSWORD_LENGTH })
  @IsString()
  @MinLength(MIN_PASSWORD_LENGTH, {
    message: `비밀번호는 ${MIN_PASSWORD_LENGTH}자 이상이어야 합니다.`,
  })
  @MaxLength(72, { message: '비밀번호는 72자 이하여야 합니다.' })
  password!: string;

  @ApiProperty({ enum: UserRole, default: UserRole.FRONT_DESK })
  @IsEnum(UserRole)
  role!: UserRole;

  @ApiPropertyOptional({ description: '소속 호텔. 비우면 전 호텔 접근(본사 계정)입니다.' })
  @IsOptional()
  @IsString()
  propertyId?: string;
}

export class UpdateUserDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(1, { message: '이름을 입력해 주세요.' })
  @MaxLength(60)
  name?: string;

  @ApiPropertyOptional({ enum: UserRole })
  @IsOptional()
  @IsEnum(UserRole)
  role?: UserRole;

  @ApiPropertyOptional({ description: '비우려면 빈 문자열을 보냅니다.' })
  @IsOptional()
  @IsString()
  propertyId?: string;

  @ApiPropertyOptional({ description: '퇴사 처리는 false 로 둡니다. 계정은 삭제하지 않습니다.' })
  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

export class ResetPasswordDto {
  @ApiProperty({ minLength: MIN_PASSWORD_LENGTH })
  @IsString()
  @MinLength(MIN_PASSWORD_LENGTH, {
    message: `비밀번호는 ${MIN_PASSWORD_LENGTH}자 이상이어야 합니다.`,
  })
  @MaxLength(72)
  password!: string;
}

export class ChangePasswordDto {
  @ApiProperty({ description: '현재 비밀번호' })
  @IsString()
  currentPassword!: string;

  @ApiProperty({ minLength: MIN_PASSWORD_LENGTH })
  @IsString()
  @MinLength(MIN_PASSWORD_LENGTH, {
    message: `비밀번호는 ${MIN_PASSWORD_LENGTH}자 이상이어야 합니다.`,
  })
  @MaxLength(72)
  newPassword!: string;
}

export class ListUsersDto {
  @ApiPropertyOptional({ enum: UserRole })
  @IsOptional()
  @IsEnum(UserRole)
  role?: UserRole;

  @ApiPropertyOptional({ description: '비활성 계정 포함 여부', default: false })
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  includeInactive?: boolean;

  @ApiPropertyOptional({ description: '이름 또는 이메일 부분 검색' })
  @IsOptional()
  @IsString()
  q?: string;

  @ApiPropertyOptional({ default: 50, minimum: 1, maximum: 200 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;

  @ApiPropertyOptional({ default: 0, minimum: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset?: number;
}
