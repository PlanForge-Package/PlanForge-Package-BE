import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';

export class IssueKeyDto {
  /**
   * 기본은 이전 카드를 죽이고 새로 만든다.
   *
   * 분실 재발급인데 이전 카드가 살아 있으면 재발급의 의미가 없다. 일행에게
   * 카드를 하나 더 주는 경우에만 false 로 둔다.
   */
  @ApiPropertyOptional({
    default: true,
    description: 'false 면 기존 카드를 살려 둡니다(일행 추가 발급).',
  })
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  replaceExisting?: boolean;
}

export class RevokeKeyDto {
  @ApiPropertyOptional({ description: '무효화 사유 — 분실·객실 변경 등' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  reason?: string;
}
