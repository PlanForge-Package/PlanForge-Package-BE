import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsEmail,
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
   * 매진이어도 대기로 받는다.
   *
   * 대기 예약은 재고를 차지하지 않고, 자리가 나면 확정으로 올린다. 이 값을
   * 주지 않으면 매진일 때 OPERA 가 예약 자체를 거절한다.
   */
  @ApiPropertyOptional({ description: '매진이어도 대기로 받을지', default: false })
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  waitlist?: boolean;

  /**
   * 예약 경로.
   *
   * 허용 코드 검증은 OPERA 가 한다 — 호텔마다 설정이 다르므로 여기에 목록을
   * 박아 두면 설정이 바뀔 때마다 두 곳을 고쳐야 한다.
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
   * `@ValidateNested()` 가 없으면 전역 ValidationPipe 의 whitelist 가 중첩 객체를
   * "검증 대상이 아닌 속성" 으로 보고 통째로 걷어낸다. forbidNonWhitelisted 까지
   * 켜 두었으므로 요청 자체가 400 으로 거절된다.
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
