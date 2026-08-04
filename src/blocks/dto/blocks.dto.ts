import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { BlockStatus } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsEnum,
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

export class ListBlocksDto {
  @ApiPropertyOptional({ description: 'PlanForge Property ID' })
  @IsOptional()
  @IsString()
  propertyId?: string;

  @ApiPropertyOptional({ enum: BlockStatus })
  @IsOptional()
  @IsEnum(BlockStatus)
  status?: BlockStatus;

  @ApiPropertyOptional({ description: '이 날짜 이후 진행되는 블록', example: '2026-08-10' })
  @IsOptional()
  @Matches(DATE_ONLY, { message: 'startFrom 은 YYYY-MM-DD 형식이어야 합니다.' })
  startFrom?: string;
}

export class BlockAllotmentInputDto {
  @ApiProperty({ example: 'DLXK' })
  @IsString()
  @MaxLength(20)
  roomTypeCode!: string;

  @ApiProperty({ description: '기간 전체에 걸쳐 잡을 객실 수', example: 10 })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(999)
  blocked!: number;

  @ApiPropertyOptional({ example: 'CORP' })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  ratePlanCode?: string;

  /** 단체는 값을 따로 합의한다. 넣으면 요금 코드의 계산 대신 이 금액으로 판다. */
  @ApiPropertyOptional({ description: '협의 요금', example: 150000 })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: '협의 요금은 정수여야 합니다.' })
  @Min(0)
  amount?: number;
}

export class BlockRateInputDto {
  @ApiProperty({ example: 'DLXK' })
  @IsString()
  @MaxLength(20)
  roomTypeCode!: string;

  @ApiPropertyOptional({ example: 'CORP' })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  ratePlanCode?: string;

  @ApiProperty({ example: 150000 })
  @Type(() => Number)
  @IsInt({ message: '협의 요금은 정수여야 합니다.' })
  @Min(0)
  amount!: number;
}

export class CreateBlockDto {
  @ApiPropertyOptional({ description: 'PlanForge Property ID' })
  @IsOptional()
  @IsString()
  propertyId?: string;

  @ApiProperty({ description: '예약 시 지정하는 블록 코드', example: 'SPGRP' })
  @IsString()
  @Matches(/^[A-Za-z0-9_-]+$/, {
    message: '블록 코드는 영문·숫자·하이픈·밑줄만 쓸 수 있습니다.',
  })
  @MaxLength(20)
  code!: string;

  @ApiProperty({ example: '스페이스플래닝 워크숍' })
  @IsString()
  @MaxLength(100)
  name!: string;

  @ApiProperty({ example: '2026-09-01' })
  @Matches(DATE_ONLY, { message: 'startDate 는 YYYY-MM-DD 형식이어야 합니다.' })
  startDate!: string;

  @ApiProperty({ example: '2026-09-03' })
  @Matches(DATE_ONLY, { message: 'endDate 는 YYYY-MM-DD 형식이어야 합니다.' })
  endDate!: string;

  @ApiPropertyOptional({ description: '이 날짜가 지나면 남은 객실을 일반 재고로 푼다' })
  @IsOptional()
  @Matches(DATE_ONLY, { message: 'cutoffDate 는 YYYY-MM-DD 형식이어야 합니다.' })
  cutoffDate?: string;

  @ApiPropertyOptional({ enum: BlockStatus, default: BlockStatus.TENTATIVE })
  @IsOptional()
  @IsEnum(BlockStatus)
  status?: BlockStatus;

  /** 중첩 배열도 `@ValidateNested({ each: true })` 가 없으면 whitelist 가 걷어낸다. */
  @ApiProperty({ type: [BlockAllotmentInputDto] })
  @ValidateNested({ each: true })
  @ArrayMinSize(1, { message: '객실 타입을 하나 이상 지정해 주세요.' })
  @ArrayMaxSize(20)
  @Type(() => BlockAllotmentInputDto)
  allotments!: BlockAllotmentInputDto[];
}

export class UpdateBlockDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  name?: string;

  @ApiPropertyOptional({ enum: BlockStatus })
  @IsOptional()
  @IsEnum(BlockStatus)
  status?: BlockStatus;

  @ApiPropertyOptional()
  @IsOptional()
  @Matches(DATE_ONLY, { message: 'cutoffDate 는 YYYY-MM-DD 형식이어야 합니다.' })
  cutoffDate?: string;

  /** 협의 요금 조정. 보낸 객실 타입만 바꾼다. */
  @ApiPropertyOptional({ type: [BlockRateInputDto] })
  @IsOptional()
  @ValidateNested({ each: true })
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  @Type(() => BlockRateInputDto)
  rates?: BlockRateInputDto[];
}
