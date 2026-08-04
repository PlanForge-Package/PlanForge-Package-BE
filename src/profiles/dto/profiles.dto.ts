import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { MembershipTier, ProfileType } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEmail,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

/**
 * Preference codes.
 *
 * Taken as free text, "high floor" and "upper floor" mix together and nobody can
 * filter at assignment time. Codes are enforced and the screen handles the wording.
 */
export const PREFERENCE_CODES = [
  'HIGH_FLOOR',
  'LOW_FLOOR',
  'NON_SMOKING',
  'SMOKING',
  'QUIET_ROOM',
  'NEAR_ELEVATOR',
  'AWAY_FROM_ELEVATOR',
  'EXTRA_PILLOW',
  'FIRM_PILLOW',
  'TWIN_BED',
  'KING_BED',
  'LATE_CHECKOUT',
  'EARLY_CHECKIN',
  'ACCESSIBLE',
] as const;

export class ListProfilesDto {
  @ApiPropertyOptional({ description: '이름·이메일·전화·멤버십 번호 검색' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string;

  @ApiPropertyOptional({ enum: ProfileType })
  @IsOptional()
  @IsEnum(ProfileType)
  type?: ProfileType;

  @ApiPropertyOptional({ enum: MembershipTier })
  @IsOptional()
  @IsEnum(MembershipTier)
  tier?: MembershipTier;

  @ApiPropertyOptional({ description: 'VIP 만 보기' })
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  vip?: boolean;

  /** Merged profiles are not canonical, so they are hidden by default. */
  @ApiPropertyOptional({ description: '병합된 프로필도 포함' })
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  includeMerged?: boolean;

  @ApiPropertyOptional({ default: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;

  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset?: number;
}

export class UpdateProfileDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(60)
  firstName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(60)
  lastName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  companyName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsEmail({}, { message: '올바른 이메일 형식이 아닙니다.' })
  email?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(30)
  phone?: string;

  @ApiPropertyOptional({ description: 'ISO 3166-1 alpha-2', example: 'KR' })
  @IsOptional()
  @Matches(/^[A-Za-z]{2}$/, { message: '국적은 두 자리 국가 코드로 입력해 주세요.' })
  nationality?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  vip?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(40)
  membershipNumber?: string;

  @ApiPropertyOptional({ enum: MembershipTier })
  @IsOptional()
  @IsEnum(MembershipTier)
  membershipTier?: MembershipTier;

  @ApiPropertyOptional({ isArray: true, enum: PREFERENCE_CODES })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  preferences?: string[];

  @ApiPropertyOptional({ description: '내부 메모. 게스트에게 노출하지 않습니다.' })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;
}

export class MergeProfileDto {
  @ApiProperty({ description: '남길 프로필 ID. 이쪽으로 합쳐집니다.' })
  @IsString()
  targetId!: string;
}
