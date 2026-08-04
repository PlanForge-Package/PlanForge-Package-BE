import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';

export class IssueKeyDto {
  /**
   * By default the previous card is killed and a new one made.
   *
   * Reissuing after a loss is pointless if the old card is still alive. Set false
   * only when handing an extra card to someone in the same party.
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
