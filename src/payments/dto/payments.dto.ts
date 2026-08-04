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
   * One-time token the terminal or payment window got from the PSP.
   *
   * **Not a card number.** Accepting numbers here turns this system into card-data
   * storage and changes what a leak means.
   */
  @ApiPropertyOptional({ description: 'PG 결제 토큰. 카드 결제에만 필요합니다.' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  paymentToken?: string;

  /**
   * Request idempotency key.
   *
   * A resend charges the same card twice. Money leaving a guest twice is harder to
   * undo than anything else here.
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
