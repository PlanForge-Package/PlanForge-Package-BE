import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import type { AuthUser } from '../auth/auth.constants';
import { Roles } from '../auth/auth.constants';
import { CurrentUser } from '../auth/current-user.decorator';
import { DailyReportDto } from './dto/reports.dto';
import { ReportsService } from './reports.service';

@ApiTags('reports')
@ApiBearerAuth()
@Controller('reports')
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  // 매출 지표는 경영 정보다. 프런트데스크에게는 열지 않는다.
  @Get('daily')
  @Roles(UserRole.MANAGER)
  @ApiOperation({ summary: '일별 실적 — 점유율·ADR·RevPAR·매출' })
  daily(@Query() query: DailyReportDto, @CurrentUser() user: AuthUser) {
    return this.reports.daily(query, user);
  }
}
