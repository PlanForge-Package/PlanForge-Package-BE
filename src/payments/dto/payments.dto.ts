import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PaymentMethod } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  IsEnum,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';

export class AuthorizePaymentDto {
  @ApiProperty({ enum: PaymentMethod })
  @IsEnum(PaymentMethod)
  method!: PaymentMethod;

  @ApiProperty({ example: 340000 })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive({ message: '금액은 0보다 커야 합니다.' })
  amount!: number;

  /**
   * 단말·결제창이 PG 에서 받아 온 일회성 토큰.
   *
   * **카드 번호가 아니다.** 번호를 여기로 받으면 이 시스템이 카드 정보 보관
   * 설비가 되고 책임 범위가 달라진다.
   */
  @ApiPropertyOptional({ description: 'PG 결제 토큰. 카드 결제에만 필요합니다.' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  paymentToken?: string;

  /**
   * 요청 멱등키.
   *
   * 재전송되면 같은 카드로 두 번 긁힌다. 손님 돈이 두 번 나가는 일은 그 무엇보다
   * 되돌리기 어렵다.
   */
  @ApiProperty({ description: '재전송 시 중복 결제를 막습니다.' })
  @IsString()
  @Matches(/^[A-Za-z0-9_-]+$/, { message: '멱등키는 영문·숫자·하이픈·밑줄만 쓸 수 있습니다.' })
  @MaxLength(80)
  idempotencyKey!: string;

  @ApiPropertyOptional({ example: '객실료 정산' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  description?: string;
}

export class CapturePaymentDto {
  @ApiPropertyOptional({ description: '비우면 승인액 전액을 매입합니다.' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive({ message: '금액은 0보다 커야 합니다.' })
  amount?: number;
}

export class RefundPaymentDto {
  @ApiProperty({ example: 50000 })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive({ message: '금액은 0보다 커야 합니다.' })
  amount!: number;

  @ApiPropertyOptional({ description: '환불 사유' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  reason?: string;
}
