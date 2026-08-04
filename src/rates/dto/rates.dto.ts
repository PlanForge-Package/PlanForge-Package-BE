import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export class ListRatePlansDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  propertyId?: string;

  @ApiPropertyOptional({ enum: ['Active', 'Inactive'] })
  @IsOptional()
  @IsIn(['Active', 'Inactive'])
  status?: 'Active' | 'Inactive';
}

export class QuoteRatesDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  propertyId?: string;

  @ApiProperty({ example: '2026-08-10' })
  @Matches(DATE, { message: '도착일은 YYYY-MM-DD 형식이어야 합니다.' })
  arrivalDate!: string;

  @ApiProperty({ example: '2026-08-12' })
  @Matches(DATE, { message: '출발일은 YYYY-MM-DD 형식이어야 합니다.' })
  departureDate!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  roomTypeCode?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  ratePlanCode?: string;

  @ApiPropertyOptional({ minimum: 1, maximum: 10 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(10)
  adults?: number;
}

export class CreateRatePlanDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  propertyId?: string;

  @ApiProperty({ example: 'PROMO' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(20)
  ratePlanCode!: string;

  @ApiProperty({ example: '여름 프로모션' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @ApiPropertyOptional({ example: 'TRANSIENT' })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  marketCode?: string;

  @ApiProperty({ example: '2026-06-01' })
  @Matches(DATE, { message: '판매 시작일은 YYYY-MM-DD 형식이어야 합니다.' })
  sellStartDate!: string;

  @ApiProperty({ example: '2026-08-31' })
  @Matches(DATE, { message: '판매 종료일은 YYYY-MM-DD 형식이어야 합니다.' })
  sellEndDate!: string;

  /** 객실 타입 코드 → 금액. 여기 없는 객실 타입은 이 요금으로 팔지 않는다. */
  @ApiProperty({ example: { STDT: 190000, DLXK: 240000 } })
  @IsObject()
  baseAmounts!: Record<string, number>;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  packageCodes?: string[];

  @ApiPropertyOptional({ enum: ['Active', 'Inactive'] })
  @IsOptional()
  @IsIn(['Active', 'Inactive'])
  status?: 'Active' | 'Inactive';
}

export class UpdateRatePlanDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  propertyId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(20)
  marketCode?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Matches(DATE, { message: '판매 시작일은 YYYY-MM-DD 형식이어야 합니다.' })
  sellStartDate?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Matches(DATE, { message: '판매 종료일은 YYYY-MM-DD 형식이어야 합니다.' })
  sellEndDate?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsObject()
  baseAmounts?: Record<string, number>;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  packageCodes?: string[];

  @ApiPropertyOptional({ enum: ['Active', 'Inactive'] })
  @IsOptional()
  @IsIn(['Active', 'Inactive'])
  status?: 'Active' | 'Inactive';
}

export class CreateSeasonDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  propertyId?: string;

  @ApiProperty({ example: '성수기 주말' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name!: string;

  @ApiProperty({ example: '2026-07-15' })
  @Matches(DATE, { message: '시작일은 YYYY-MM-DD 형식이어야 합니다.' })
  startDate!: string;

  @ApiProperty({ example: '2026-08-20' })
  @Matches(DATE, { message: '종료일은 YYYY-MM-DD 형식이어야 합니다.' })
  endDate!: string;

  /** 0=일요일. 비우면 기간 내 매일 적용한다. */
  @ApiPropertyOptional({ type: [Number], example: [5, 6] })
  @IsOptional()
  @IsArray()
  @Type(() => Number)
  @IsInt({ each: true })
  @Min(0, { each: true })
  @Max(6, { each: true })
  daysOfWeek?: number[];

  @ApiProperty({ example: { DLXK: 320000 } })
  @IsObject()
  amounts!: Record<string, number>;
}

export class DeleteSeasonDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  propertyId?: string;
}

export class ListPackagesDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  propertyId?: string;
}

export class CreatePackageDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  propertyId?: string;

  @ApiProperty({ example: 'BFAST' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(20)
  packageCode!: string;

  @ApiProperty({ example: '조식' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name!: string;

  @ApiProperty({ example: 25000 })
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  amount!: number;

  @ApiProperty({ enum: ['PerNight', 'PerStay', 'PerPerson'] })
  @IsIn(['PerNight', 'PerStay', 'PerPerson'])
  calculation!: 'PerNight' | 'PerStay' | 'PerPerson';

  @ApiProperty({ example: '2000' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(20)
  transactionCode!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  includedInRate?: boolean;
}

export class UpdatePackageDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  propertyId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  amount?: number;

  @ApiPropertyOptional({ enum: ['PerNight', 'PerStay', 'PerPerson'] })
  @IsOptional()
  @IsIn(['PerNight', 'PerStay', 'PerPerson'])
  calculation?: 'PerNight' | 'PerStay' | 'PerPerson';

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(20)
  transactionCode?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  includedInRate?: boolean;
}
