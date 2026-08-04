import { ApiPropertyOptional } from '@nestjs/swagger';
import { RoomStatus } from '@prisma/client';
import { Type } from 'class-transformer';
import { IsBoolean, IsEnum, IsOptional, IsString } from 'class-validator';

// The status change DTO moved to housekeeping/dto — it is a write that delegates to OPERA.

export class ListRoomsDto {
  @ApiPropertyOptional({ description: 'PlanForge Property ID' })
  @IsOptional()
  @IsString()
  propertyId?: string;

  @ApiPropertyOptional({ enum: RoomStatus })
  @IsOptional()
  @IsEnum(RoomStatus)
  status?: RoomStatus;

  @ApiPropertyOptional({ description: '재실 여부로 필터' })
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  occupied?: boolean;
}
