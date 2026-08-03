import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsInt,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  Matches,
  MaxLength,
  Min,
} from 'class-validator';

export class PostRoomChargeDto {
  @ApiProperty({ example: '1203' })
  @IsString()
  @MaxLength(10)
  roomNumber!: string;

  @ApiProperty({ description: '양수로 보냅니다. 부호는 서버가 붙입니다.', example: 45000 })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive({ message: '금액은 0보다 커야 합니다.' })
  amount!: number;

  @ApiProperty({ example: '레스토랑 — 조식 2인' })
  @IsString()
  @MaxLength(120)
  description!: string;

  /**
   * POS 전표 번호.
   *
   * 네트워크가 끊겨 같은 요청이 다시 오는 일은 흔하다. 같은 아웃렛의 같은
   * 전표는 한 번만 달린다 — 손님에게 두 번 청구되면 되돌리기 어렵다.
   */
  @ApiProperty({ description: 'POS 전표 번호. 재전송 시 중복 청구를 막습니다.' })
  @IsString()
  @Matches(/^[A-Za-z0-9_-]+$/, { message: '전표 번호는 영문·숫자·하이픈·밑줄만 쓸 수 있습니다.' })
  @MaxLength(60)
  reference!: string;

  @ApiPropertyOptional({ description: '비우면 아웃렛의 기본 거래 코드를 씁니다.' })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  transactionCode?: string;

  @ApiPropertyOptional({ description: '분할 정산 중이면 폴리오 윈도 번호', default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  window?: number;
}

export class VoidRoomChargeDto {
  @ApiProperty({ description: '취소할 전표 번호' })
  @IsString()
  @MaxLength(60)
  reference!: string;

  @ApiPropertyOptional({ description: '취소 사유' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  reason?: string;
}

export class CreateOutletDto {
  @ApiPropertyOptional({ description: 'PlanForge Property ID' })
  @IsOptional()
  @IsString()
  propertyId?: string;

  @ApiProperty({ example: 'RESTAURANT' })
  @IsString()
  @Matches(/^[A-Z0-9_]+$/, { message: '아웃렛 코드는 대문자·숫자·밑줄만 쓸 수 있습니다.' })
  @MaxLength(20)
  code!: string;

  @ApiProperty({ example: '1층 레스토랑' })
  @IsString()
  @MaxLength(60)
  name!: string;

  @ApiProperty({ description: '이 아웃렛이 다는 요금의 기본 거래 코드', example: 'FNB' })
  @IsString()
  @Matches(/^[A-Z0-9_]+$/, { message: '거래 코드는 대문자·숫자·밑줄만 쓸 수 있습니다.' })
  @MaxLength(20)
  transactionCode!: string;
}

export class UpdateOutletDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(60)
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Matches(/^[A-Z0-9_]+$/, { message: '거래 코드는 대문자·숫자·밑줄만 쓸 수 있습니다.' })
  @MaxLength(20)
  transactionCode?: string;

  @ApiPropertyOptional({ description: '단말을 치웠으면 false 로 둡니다.' })
  @IsOptional()
  @Type(() => Boolean)
  active?: boolean;
}
