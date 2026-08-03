import { ApiPropertyOptional } from '@nestjs/swagger';
import { ReservationStatus } from '@prisma/client';
import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsString, Matches, Max, Min } from 'class-validator';

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

export class ListReservationsDto {
  @ApiPropertyOptional({ description: 'PlanForge Property ID' })
  @IsOptional()
  @IsString()
  propertyId?: string;

  @ApiPropertyOptional({ enum: ReservationStatus })
  @IsOptional()
  @IsEnum(ReservationStatus)
  status?: ReservationStatus;

  @ApiPropertyOptional({ description: '이 날짜 이후 도착 (YYYY-MM-DD)' })
  @IsOptional()
  @Matches(DATE_ONLY, { message: 'arrivalFrom 은 YYYY-MM-DD 형식이어야 합니다.' })
  arrivalFrom?: string;

  @ApiPropertyOptional({ description: '이 날짜 이전 도착 (YYYY-MM-DD)' })
  @IsOptional()
  @Matches(DATE_ONLY, { message: 'arrivalTo 는 YYYY-MM-DD 형식이어야 합니다.' })
  arrivalTo?: string;

  @ApiPropertyOptional({ description: '확인 번호 또는 게스트 이름 부분 검색' })
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
