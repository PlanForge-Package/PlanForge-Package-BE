import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, Matches } from 'class-validator';

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

export class DailyReportDto {
  @ApiPropertyOptional({ description: 'PlanForge Property ID' })
  @IsOptional()
  @IsString()
  propertyId?: string;

  @ApiProperty({ example: '2026-08-01' })
  @Matches(DATE_ONLY, { message: 'from 은 YYYY-MM-DD 형식이어야 합니다.' })
  from!: string;

  @ApiProperty({ example: '2026-08-07' })
  @Matches(DATE_ONLY, { message: 'to 는 YYYY-MM-DD 형식이어야 합니다.' })
  to!: string;
}
