import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import type { AuthUser } from '../auth/auth.constants';
import { Roles } from '../auth/auth.constants';
import { CurrentUser } from '../auth/current-user.decorator';
import { CashierService } from './cashier.service';
import { CloseShiftDto, ListShiftsDto, OpenShiftDto } from './dto/cashier.dto';

/**
 * 캐셔 근무조.
 *
 * 돈을 받는 사람이 쓰는 화면이므로 프론트데스크와 지배인이 대상이다.
 * 지난 조 목록은 차이가 났을 때 되짚는 용도라 같은 범위로 둔다.
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
