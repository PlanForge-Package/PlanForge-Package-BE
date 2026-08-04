import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsEmail,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

export class GuestInputDto {
  @ApiPropertyOptional({ description: '기존 OPERA 프로필 ID. 없으면 새로 만듭니다.' })
  @IsOptional()
  @IsString()
  profileId?: string;

  @ApiProperty({ example: '길동' })
  @IsString()
  @MaxLength(60)
  firstName!: string;

  @ApiProperty({ example: '홍' })
  @IsString()
  @MaxLength(60)
  lastName!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsEmail({}, { message: '올바른 이메일 형식이 아닙니다.' })
  email?: string;
}

export class CheckAvailabilityDto {
  @ApiPropertyOptional({ description: 'PlanForge Property ID' })
  @IsOptional()
  @IsString()
  propertyId?: string;

  @ApiProperty({ example: '2026-08-10' })
  @Matches(DATE_ONLY, { message: 'arrivalDate 는 YYYY-MM-DD 형식이어야 합니다.' })
  arrivalDate!: string;

  @ApiProperty({ example: '2026-08-12' })
  @Matches(DATE_ONLY, { message: 'departureDate 는 YYYY-MM-DD 형식이어야 합니다.' })
  departureDate!: string;

  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(10)
  adults?: number;

  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(10)
  children?: number;
}

export class CreateBookingDto extends CheckAvailabilityDto {
  @ApiProperty({ example: 'DLXK' })
  @IsString()
  roomTypeCode!: string;

  @ApiPropertyOptional({ example: 'BAR' })
  @IsOptional()
  @IsString()
  ratePlanCode?: string;

  @ApiPropertyOptional({
    description: '단체 블록에서 빼는 예약이면 블록 코드. OPERA 가 픽업으로 잡습니다.',
    example: 'SPGRP',
  })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  blockCode?: string;

  /**
   * Take a waitlist booking even when sold out.
   *
   * A waitlisted reservation holds no inventory and is confirmed when a room opens.
   * Without this flag OPERA rejects the booking outright when sold out.
   */
  @ApiPropertyOptional({ description: '매진이어도 대기로 받을지', default: false })
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  waitlist?: boolean;

  /** Guarantee type. Empty means 6PM — an unguaranteed booking is held until 18:00. */
  @ApiPropertyOptional({ description: 'SIXPM · CREDITCARD · DEPOSIT · COMPANY · COMP' })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  guaranteeCode?: string;

  /**
   * Booking origin.
   *
   * OPERA validates the allowed codes — the setup differs per hotel, so a list baked
   * in here would need fixing in two places every time it changes.
   */
  @ApiPropertyOptional({ example: 'OTA', description: 'DIRECT · PHONE · WALKIN · OTA · GDS …' })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  sourceCode?: string;

  @ApiPropertyOptional({ example: 'LEISURE' })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  marketCode?: string;

  @ApiPropertyOptional({ example: 'BOOKINGCOM' })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  channelCode?: string;

  /**
   * Without `@ValidateNested()` the global ValidationPipe's whitelist treats a nested
   * object as an unvalidated property and strips it entirely. With forbidNonWhitelisted
   * also on, the request itself is rejected with a 400.
   */
  @ApiProperty({ type: GuestInputDto })
  @ValidateNested()
  @Type(() => GuestInputDto)
  guest!: GuestInputDto;
}

export class UpdateBookingDto {
  @ApiPropertyOptional()
  @IsOptional()
  @Matches(DATE_ONLY, { message: 'arrivalDate 는 YYYY-MM-DD 형식이어야 합니다.' })
  arrivalDate?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Matches(DATE_ONLY, { message: 'departureDate 는 YYYY-MM-DD 형식이어야 합니다.' })
  departureDate?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  roomTypeCode?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  ratePlanCode?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(10)
  adults?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(10)
  children?: number;
}

export class CancelBookingDto {
  @ApiPropertyOptional({ description: '취소 사유' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  reason?: string;
}

/** Room share. Names the partner reservation to group with. */
export class ShareReservationDto {
  @ApiProperty({ description: '함께 묶을 상대 예약 ID' })
  @IsString()
  @MaxLength(60)
  withReservationId!: string;
}

/** Guarantee type. It decides what we can charge when the guest never shows. */
export const GUARANTEE_CODES = ['SIXPM', 'CREDITCARD', 'DEPOSIT', 'COMPANY', 'COMP'] as const;

export class SetGuaranteeDto {
  @ApiProperty({ enum: GUARANTEE_CODES })
  @IsIn(GUARANTEE_CODES as unknown as string[], {
    message: `보증 방식은 ${GUARANTEE_CODES.join(', ')} 중 하나여야 합니다.`,
  })
  guaranteeCode!: string;
}
