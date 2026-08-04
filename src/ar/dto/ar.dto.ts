import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ArInvoiceStatus } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsEnum,
  IsInt,
  IsOptional,
  IsPositive,
  IsString,
  Matches,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

export class ListAccountsDto {
  @ApiPropertyOptional({ description: 'PlanForge Property ID' })
  @IsOptional()
  @IsString()
  propertyId?: string;

  @ApiPropertyOptional({ description: '코드·이름 검색' })
  @IsOptional()
  @IsString()
  q?: string;

  @ApiPropertyOptional({ description: '중지된 거래처까지 포함', default: false })
  @IsOptional()
  @IsString()
  includeInactive?: string;
}

export class CreateAccountDto {
  @ApiPropertyOptional({ description: 'PlanForge Property ID' })
  @IsOptional()
  @IsString()
  propertyId?: string;

  @ApiProperty({ description: '거래처 코드', example: 'SPACEPL' })
  @IsString()
  @MinLength(1)
  @MaxLength(20)
  code!: string;

  @ApiProperty({ description: '거래처 이름', example: '스페이스플래닝' })
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name!: string;

  @ApiPropertyOptional({ description: '연결할 프로필 ID (회사·여행사)' })
  @IsOptional()
  @IsString()
  profileId?: string;

  @ApiPropertyOptional({ description: '여신 한도. 비우면 한도 없음.' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  creditLimit?: number;

  @ApiPropertyOptional({ description: '결제 조건(일)', default: 30 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  termDays?: number;

  @ApiPropertyOptional({ description: '청구서를 받을 이메일' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  billingEmail?: string;

  @ApiPropertyOptional({ description: '메모' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;
}

export class UpdateAccountDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  creditLimit?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  termDays?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  billingEmail?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;

  @ApiPropertyOptional({ description: '거래 중지. 중지하면 새 이관을 받지 않습니다.' })
  @IsOptional()
  @IsString()
  active?: string;
}

/** Transfers a folio balance to an account. */
export class TransferToArDto {
  @ApiProperty({ description: '받을 거래처 ID' })
  @IsString()
  accountId!: string;

  @ApiProperty({ description: '넘길 폴리오 창구', example: 1 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  window!: number;

  @ApiPropertyOptional({ description: '적요. 비우면 예약 확인 번호로 적습니다.' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  description?: string;
}

/** Account payment. */
export class AllocationInputDto {
  @ApiProperty({ description: '붙일 청구서' })
  @IsString()
  @MinLength(1)
  invoiceId!: string;

  @ApiProperty({ description: '이 청구서에 붙일 금액 (양수)' })
  @Type(() => Number)
  @IsPositive()
  amount!: number;
}

export class RecordArPaymentDto {
  @ApiProperty({ description: '입금액 (양수)' })
  @Type(() => Number)
  @IsPositive()
  amount!: number;

  @ApiProperty({ description: '적요', example: '10월분 입금' })
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  description!: string;

  /**
   * How much of the payment goes to which invoice.
   *
   * Left empty with `autoApply` on, the earliest-due invoices are filled first. With
   * neither, nothing is allocated and only the balance drops — a person can apply it later.
   */
  @ApiPropertyOptional({ type: [AllocationInputDto] })
  @IsOptional()
  @ValidateNested({ each: true })
  @ArrayMaxSize(50)
  @Type(() => AllocationInputDto)
  allocations?: AllocationInputDto[];

  @ApiPropertyOptional({ description: '만기가 빠른 청구서부터 자동으로 채웁니다.' })
  @IsOptional()
  @IsString()
  autoApply?: string;
}

export class AgingDto {
  @ApiPropertyOptional({ description: 'PlanForge Property ID' })
  @IsOptional()
  @IsString()
  propertyId?: string;

  @ApiPropertyOptional({ description: '기준일 (YYYY-MM-DD). 비우면 오늘입니다.' })
  @IsOptional()
  @Matches(DATE_ONLY, { message: 'asOf 는 YYYY-MM-DD 형식이어야 합니다.' })
  asOf?: string;
}

export class CreateInvoiceDto {
  @ApiPropertyOptional({ description: '청구서 번호. 비우면 자동으로 매깁니다.' })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  number?: string;

  @ApiPropertyOptional({ description: '만기일 (YYYY-MM-DD). 비우면 결제 조건으로 계산합니다.' })
  @IsOptional()
  @Matches(DATE_ONLY, { message: 'dueDate 는 YYYY-MM-DD 형식이어야 합니다.' })
  dueDate?: string;

  @ApiPropertyOptional({ description: '메모' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class UpdateInvoiceStatusDto {
  @ApiProperty({ enum: ArInvoiceStatus })
  @IsEnum(ArInvoiceStatus)
  status!: ArInvoiceStatus;
}
