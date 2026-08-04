import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PaymentMethod, PostingType } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsPositive,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export class CreatePostingDto {
  @ApiProperty({ enum: PostingType, description: '거래 종류' })
  @IsEnum(PostingType)
  type!: PostingType;

  @ApiProperty({ description: 'OPERA transactionCode', example: '1000' })
  @IsString()
  transactionCode!: string;

  @ApiProperty({ description: '적요', example: '객실료' })
  @IsString()
  description!: string;

  /**
   * 항상 양수로 보낸다. 잔액에 더할지 뺄지는 `type` 이 정한다 —
   * CHARGE·TAX 는 더하고 PAYMENT 는 뺀다. 부호를 호출자가 정하게 하면
   * 결제를 양수로 보내 잔액이 늘어나는 사고가 나기 쉽다.
   *
   * ADJUSTMENT 만 `negative: true` 로 차감 방향을 지정할 수 있다.
   */
  @ApiProperty({ description: '금액 (항상 양수)', example: 240000 })
  @Type(() => Number)
  @IsPositive({ message: 'amount 는 양수여야 합니다. 차감은 type 으로 표현합니다.' })
  amount!: number;

  @ApiPropertyOptional({
    description: 'ADJUSTMENT 를 차감 방향으로 적용할지 여부. 다른 종류에서는 무시됩니다.',
    default: false,
  })
  @IsOptional()
  negative?: boolean;
}

export class TransferPostingDto {
  @ApiProperty({ description: '옮길 대상 창구 (1~8)', minimum: 1, maximum: 8 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(8)
  toWindow!: number;
}

export class SetRoutingDto {
  @ApiProperty({ description: 'OPERA transactionCode', example: '1000' })
  @IsString()
  transactionCode!: string;

  @ApiProperty({ description: '이 코드의 요금을 보낼 창구 (1~8)', minimum: 1, maximum: 8 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(8)
  targetWindow!: number;

  @ApiPropertyOptional({ description: '메모', example: '객실료는 회사 부담' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  note?: string;
}

export class OpenFolioDto {
  @ApiPropertyOptional({
    description: 'OPERA folio window 번호 (1~8). 생략하면 비어 있는 다음 번호를 씁니다.',
    minimum: 1,
    maximum: 8,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(8)
  window?: number;
}

/**
 * 보증금 수납.
 *
 * 전표 번호를 함께 보내면 같은 보증금을 두 번 받지 않는다 — 손님 돈이 두 번
 * 나가는 일은 되돌리기 어렵다.
 */
export class RecordDepositDto {
  @ApiProperty({ description: '받은 금액 (양수)', example: 100000 })
  @Type(() => Number)
  @IsInt({ message: '보증금은 정수여야 합니다.' })
  @IsPositive()
  amount!: number;

  @ApiProperty({ enum: PaymentMethod, description: '받은 방법' })
  @IsEnum(PaymentMethod)
  method!: PaymentMethod;

  @ApiPropertyOptional({ description: '적요', example: '10월 예약 보증금' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  description?: string;

  @ApiPropertyOptional({ description: '전표 번호. 같은 번호는 한 번만 처리합니다.' })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  reference?: string;
}
