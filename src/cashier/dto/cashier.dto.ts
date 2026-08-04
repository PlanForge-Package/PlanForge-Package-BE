import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, MaxLength, Min } from 'class-validator';

export class OpenShiftDto {
  @ApiPropertyOptional({ description: 'PlanForge Property ID' })
  @IsOptional()
  @IsString()
  propertyId?: string;

  @ApiPropertyOptional({ description: '시작 시재 — 거스름돈용 현금', default: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  openingFloat?: number;
}

export class CloseShiftDto {
  @ApiProperty({ description: '실제로 센 현금 (시작 시재 포함)' })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  countedCash!: number;

  @ApiPropertyOptional({ description: '메모 — 차이가 있으면 사유를 남긴다' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;
}

export class ListShiftsDto {
  @ApiPropertyOptional({ description: 'PlanForge Property ID' })
  @IsOptional()
  @IsString()
  propertyId?: string;

  @ApiPropertyOptional({ description: '조회 개수', default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit?: number;
}
