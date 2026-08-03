import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

export class ReviewNightAuditDto {
  @ApiPropertyOptional({ description: 'PlanForge Property ID' })
  @IsOptional()
  @IsString()
  propertyId?: string;
}

export class NoShowDto {
  @ApiPropertyOptional({ description: '노쇼 사유. 수수료 청구 근거로 남습니다.' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  reason?: string;
}
