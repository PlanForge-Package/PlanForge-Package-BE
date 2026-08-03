import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import type { AuthUser } from '../auth/auth.constants';
import { Roles } from '../auth/auth.constants';
import { CurrentUser } from '../auth/current-user.decorator';
import { NoShowDto, ReviewNightAuditDto } from './dto/night-audit.dto';
import { NightAuditService } from './night-audit.service';

@ApiTags('night-audit')
@ApiBearerAuth()
@Controller('night-audit')
export class NightAuditController {
  constructor(private readonly nightAudit: NightAuditService) {}

  // 마감 점검은 야간 근무 프론트데스크가 직접 본다.
  @Get()
  @Roles(UserRole.MANAGER, UserRole.FRONT_DESK)
  @ApiOperation({ summary: '야간 감사 점검표 — 지금 마감하면 무엇이 잘못 남는가' })
  review(@Query() query: ReviewNightAuditDto, @CurrentUser() user: AuthUser) {
    return this.nightAudit.review(query.propertyId, user);
  }

  @Post('reservations/:id/no-show')
  @Roles(UserRole.MANAGER, UserRole.FRONT_DESK)
  @ApiOperation({ summary: '노쇼 처리 — OPERA 에 반영 후 미러링' })
  noShow(@Param('id') id: string, @Body() dto: NoShowDto, @CurrentUser() user: AuthUser) {
    return this.nightAudit.markNoShow(id, dto.reason, user);
  }
}
