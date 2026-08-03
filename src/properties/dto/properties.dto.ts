import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional, IsString, Length, MaxLength, MinLength } from 'class-validator';

export class CreatePropertyDto {
  @ApiProperty({ description: 'OPERA 호텔 코드', example: 'SAND01' })
  @IsString()
  @MinLength(1, { message: 'OPERA 호텔 코드를 입력해 주세요.' })
  @MaxLength(20)
  operaHotelId!: string;

  @ApiProperty({ example: 'PlanForge Seoul' })
  @IsString()
  @MinLength(1, { message: '호텔 이름을 입력해 주세요.' })
  @MaxLength(100)
  name!: string;

  @ApiPropertyOptional({ default: 'Asia/Seoul' })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  timezone?: string;

  @ApiPropertyOptional({ default: 'KRW', description: 'ISO 4217 통화 코드' })
  @IsOptional()
  @IsString()
  @Length(3, 3, { message: '통화 코드는 3자입니다 (예: KRW).' })
  @Transform(({ value }) => (typeof value === 'string' ? value.toUpperCase() : value))
  currency?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  address?: string;
}

export class UpdatePropertyDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(1, { message: '호텔 이름을 입력해 주세요.' })
  @MaxLength(100)
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(60)
  timezone?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(3, 3, { message: '통화 코드는 3자입니다 (예: KRW).' })
  @Transform(({ value }) => (typeof value === 'string' ? value.toUpperCase() : value))
  currency?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  address?: string;

  @ApiPropertyOptional({ description: '운영 중단은 false 로 둡니다. 삭제하지 않습니다.' })
  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

export class ListPropertiesDto {
  @ApiPropertyOptional({ description: '운영 중단 호텔 포함 여부', default: false })
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  includeInactive?: boolean;
}
