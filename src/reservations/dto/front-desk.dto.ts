import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';

export class CheckInDto {
  @ApiPropertyOptional({
    description: '배정할 객실 번호. 생략하면 예약에 이미 배정된 객실을 사용합니다.',
    example: '1203',
  })
  @IsOptional()
  @IsString()
  roomNumber?: string;
}

export class CheckOutDto {
  @ApiPropertyOptional({ description: '체크아웃 메모' })
  @IsOptional()
  @IsString()
  notes?: string;
}
