import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { TraceDepartment, TraceStatus } from '@prisma/client';
import { IsEnum, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

export class CreateTraceDto {
  @ApiProperty({ enum: TraceDepartment, description: '지시를 받을 부서' })
  @IsEnum(TraceDepartment)
  department!: TraceDepartment;

  @ApiProperty({ description: '처리해야 하는 날짜 (YYYY-MM-DD)' })
  @Matches(DATE_ONLY, { message: 'dueDate 는 YYYY-MM-DD 형식이어야 합니다.' })
  dueDate!: string;

  @ApiProperty({ description: '지시 내용', example: '유아용 침대 준비' })
  @IsString()
  @MinLength(1)
  @MaxLength(300)
  note!: string;
}

export class ListTracesDto {
  @ApiPropertyOptional({ description: 'PlanForge Property ID' })
  @IsOptional()
  @IsString()
  propertyId?: string;

  @ApiPropertyOptional({ description: '처리 날짜 (YYYY-MM-DD). 생략하면 오늘.' })
  @IsOptional()
  @Matches(DATE_ONLY, { message: 'date 는 YYYY-MM-DD 형식이어야 합니다.' })
  date?: string;

  @ApiPropertyOptional({ enum: TraceDepartment })
  @IsOptional()
  @IsEnum(TraceDepartment)
  department?: TraceDepartment;

  @ApiPropertyOptional({ enum: TraceStatus })
  @IsOptional()
  @IsEnum(TraceStatus)
  status?: TraceStatus;
}
