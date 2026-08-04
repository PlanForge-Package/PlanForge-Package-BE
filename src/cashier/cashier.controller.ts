import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import type { AuthUser } from '../auth/auth.constants';
import { Roles } from '../auth/auth.constants';
import { CurrentUser } from '../auth/current-user.decorator';
import { CashierService } from './cashier.service';
import { CloseShiftDto, ListShiftsDto, OpenShiftDto } from './dto/cashier.dto';

/**
 * Cashier shifts.
 *
 * The screen is used by whoever takes the money, so the front desk and managers.
 * Past shifts are for tracing a discrepancy, so they keep the same scope.
 */
@ApiTags('cashier')
@ApiBearerAuth()
@Roles(UserRole.MANAGER, UserRole.FRONT_DESK)
@Controller('cashier')
export class CashierController {
  constructor(private readonly cashier: CashierService) {}

  @Get('shifts/current')
  @ApiOperation({ summary: '지금 열려 있는 내 근무조와 집계' })
  current(@CurrentUser() user: AuthUser) {
    return this.cashier.current(user);
  }

  @Get('shifts')
  @ApiOperation({ summary: '지난 근무조 목록' })
  list(@Query() query: ListShiftsDto, @CurrentUser() user: AuthUser) {
    return this.cashier.list(query, user);
  }

  @Get('shifts/:id')
  @ApiOperation({ summary: '근무조 상세와 집계' })
  detail(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.cashier.detail(id, user);
  }

  @Post('shifts')
  @ApiOperation({ summary: '근무조 시작 — 시작 시재를 함께 적습니다' })
  open(@Body() dto: OpenShiftDto, @CurrentUser() user: AuthUser) {
    return this.cashier.open(dto, user);
  }

  @Post('shifts/:id/close')
  @ApiOperation({ summary: '마감 — 센 현금과 있어야 할 현금의 차이를 남깁니다' })
  close(@Param('id') id: string, @Body() dto: CloseShiftDto, @CurrentUser() user: AuthUser) {
    return this.cashier.close(id, dto, user);
  }
}
