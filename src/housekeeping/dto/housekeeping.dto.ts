import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { RoomStatus, TaskStatus } from '@prisma/client';
import { Transform } from 'class-transformer';
import { IsEnum, IsOptional, IsString, Matches, MaxLength } from 'class-validator';

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

export class ListTasksDto {
  @ApiPropertyOptional({ description: 'PlanForge Property ID' })
  @IsOptional()
  @IsString()
  propertyId?: string;

  @ApiPropertyOptional({ description: '근무일 (YYYY-MM-DD). 생략하면 오늘.' })
  @IsOptional()
  @Matches(DATE_ONLY, { message: 'date 는 YYYY-MM-DD 형식이어야 합니다.' })
  date?: string;

  @ApiPropertyOptional({ enum: TaskStatus })
  @IsOptional()
  @IsEnum(TaskStatus)
  status?: TaskStatus;

  @ApiPropertyOptional({ description: '배정된 직원 ID. `me` 를 넣으면 본인 작업만.' })
  @IsOptional()
  @IsString()
  assignedToId?: string;

  @ApiPropertyOptional({ description: '배정되지 않은 작업만', default: false })
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  unassignedOnly?: boolean;
}

export class GenerateTasksDto {
  @ApiPropertyOptional({ description: 'PlanForge Property ID' })
  @IsOptional()
  @IsString()
  propertyId?: string;

  @ApiPropertyOptional({ description: '근무일 (YYYY-MM-DD). 생략하면 오늘.' })
  @IsOptional()
  @Matches(DATE_ONLY, { message: 'date 는 YYYY-MM-DD 형식이어야 합니다.' })
  date?: string;
}

export class AssignTaskDto {
  @ApiPropertyOptional({ description: '배정할 직원 ID. 비우면 배정을 해제합니다.' })
  @IsOptional()
  @IsString()
  assignedToId?: string;
}

export class UpdateTaskDto {
  @ApiProperty({ enum: TaskStatus })
  @IsEnum(TaskStatus)
  status!: TaskStatus;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  notes?: string;
}

export class UpdateRoomStatusDto {
  @ApiProperty({ enum: RoomStatus, description: '하우스키핑 상태' })
  @IsEnum(RoomStatus)
  status!: RoomStatus;

  @ApiPropertyOptional({ description: '판매 불가로 돌릴 때의 사유' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  reason?: string;
}
