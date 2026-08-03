import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Matches, Max, Min } from 'class-validator';

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

export class SyncReservationsDto {
  @ApiProperty({ description: 'OPERA 호텔 코드', example: 'SAND01' })
  @IsString()
  hotelId!: string;

  @ApiPropertyOptional({ description: '도착일 시작 (YYYY-MM-DD)', example: '2026-08-01' })
  @IsOptional()
  @Matches(DATE_ONLY, { message: 'arrivalDate 는 YYYY-MM-DD 형식이어야 합니다.' })
  arrivalDate?: string;

  @ApiPropertyOptional({ description: '출발일 종료 (YYYY-MM-DD)', example: '2026-08-31' })
  @IsOptional()
  @Matches(DATE_ONLY, { message: 'departureDate 는 YYYY-MM-DD 형식이어야 합니다.' })
  departureDate?: string;

  @ApiPropertyOptional({ description: 'Core 페이지 크기', default: 100, minimum: 1, maximum: 200 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  pageSize?: number;
}
