import { ApiProperty } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { IsEmail, IsString, MinLength } from 'class-validator';

export class LoginDto {
  @ApiProperty({ example: 'admin@planforge.local' })
  @IsEmail({}, { message: '올바른 이메일 형식이 아닙니다.' })
  email!: string;

  @ApiProperty({ example: 'planforge', minLength: 8 })
  @IsString()
  @MinLength(8, { message: '비밀번호는 8자 이상이어야 합니다.' })
  password!: string;
}

export class AuthUserDto {
  @ApiProperty() id!: string;
  @ApiProperty() email!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ enum: UserRole }) role!: UserRole;
  @ApiProperty({ nullable: true }) propertyId!: string | null;
}

export class LoginResponseDto {
  @ApiProperty({ description: 'Bearer 액세스 토큰' })
  accessToken!: string;

  @ApiProperty({ description: '토큰 만료 시각 (ISO 8601)' })
  expiresAt!: string;

  @ApiProperty({ type: AuthUserDto })
  user!: AuthUserDto;
}
