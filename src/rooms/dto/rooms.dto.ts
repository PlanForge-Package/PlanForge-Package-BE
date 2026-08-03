import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { RoomStatus } from '@prisma/client';
import { Type } from 'class-transformer';
import { IsBoolean, IsEnum, IsOptional, IsString } from 'class-validator';

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

export class UpdateRoomStatusDto {
  @ApiProperty({ enum: RoomStatus, description: '하우스키핑 상태' })
  @IsEnum(RoomStatus)
  status!: RoomStatus;
}
