import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { RoomOutageKind, RoomStatus } from '@prisma/client';
import { IsEnum, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

export class ListRoomOutagesDto {
  @ApiPropertyOptional({ description: 'PlanForge Property ID' })
  @IsOptional()
  @IsString()
  propertyId?: string;

  @ApiPropertyOptional({ description: '객실 번호' })
  @IsOptional()
  @IsString()
  roomNumber?: string;

  @ApiPropertyOptional({ description: '이 날짜에 걸친 건만 (YYYY-MM-DD)' })
  @IsOptional()
  @Matches(DATE_ONLY, { message: 'onDate 는 YYYY-MM-DD 형식이어야 합니다.' })
  onDate?: string;

  @ApiPropertyOptional({ description: '해제된 건까지 포함', default: false })
  @IsOptional()
  @IsString()
  includeReleased?: string;
}

export class CreateRoomOutageDto {
  @ApiPropertyOptional({ description: 'PlanForge Property ID' })
  @IsOptional()
  @IsString()
  propertyId?: string;

  @ApiProperty({ description: '객실 번호' })
  @IsString()
  @MinLength(1)
  roomNumber!: string;

  @ApiProperty({
    enum: RoomOutageKind,
    description: 'OUT_OF_ORDER 는 재고에서 제외, OUT_OF_SERVICE 는 판매만 중지',
  })
  @IsEnum(RoomOutageKind)
  kind!: RoomOutageKind;

  @ApiProperty({ description: '사용 불가 시작일 (YYYY-MM-DD, 포함)' })
  @Matches(DATE_ONLY, { message: 'startDate 는 YYYY-MM-DD 형식이어야 합니다.' })
  startDate!: string;

  @ApiProperty({ description: '사용 불가 종료일 (YYYY-MM-DD, 포함)' })
  @Matches(DATE_ONLY, { message: 'endDate 는 YYYY-MM-DD 형식이어야 합니다.' })
  endDate!: string;

  // An outage with no reason is one nobody can release later.
  @ApiProperty({ description: '사유' })
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  reason!: string;

  @ApiPropertyOptional({
    enum: RoomStatus,
    description: '기간이 끝나면 되돌릴 상태. 생략하면 DIRTY.',
  })
  @IsOptional()
  @IsEnum(RoomStatus)
  returnStatus?: RoomStatus;
}

export class ReleaseRoomOutageDto {
  @ApiPropertyOptional({ description: '해제 사유' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  reason?: string;
}
