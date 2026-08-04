import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import type { AuthUser } from '../auth/auth.constants';
import { Roles } from '../auth/auth.constants';
import { CurrentUser } from '../auth/current-user.decorator';
import { CreateTraceDto, ListTracesDto } from './dto/traces.dto';
import { TracesService } from './traces.service';

/**
 * Trace — a departmental instruction attached to a reservation.
 *
 * Reading and completing are open to every role; housekeeping has to see and close
 * its own. Raising a new instruction is for the front desk and managers.
 */
@ApiTags('traces')
@ApiBearerAuth()
@Controller()
export class TracesController {
  constructor(private readonly traces: TracesService) {}

  @Get('traces')
  @ApiOperation({ summary: '날짜·부서별 지시 목록' })
  list(@Query() query: ListTracesDto, @CurrentUser() user: AuthUser) {
    return this.traces.list(query, user);
  }

  @Get('reservations/:reservationId/traces')
  @ApiOperation({ summary: '예약에 걸린 지시' })
  listByReservation(@Param('reservationId') reservationId: string, @CurrentUser() user: AuthUser) {
    return this.traces.listByReservation(reservationId, user);
  }

  @Post('reservations/:reservationId/traces')
  @Roles(UserRole.MANAGER, UserRole.FRONT_DESK)
  @ApiOperation({ summary: '지시 등록' })
  create(
    @Param('reservationId') reservationId: string,
    @Body() dto: CreateTraceDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.traces.create(reservationId, dto, user);
  }

  @Patch('traces/:id/complete')
  @ApiOperation({ summary: '처리 완료 — 누가 했는지 남깁니다' })
  complete(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.traces.complete(id, user);
  }

  @Delete('traces/:id')
  @Roles(UserRole.MANAGER, UserRole.FRONT_DESK)
  @ApiOperation({ summary: '지시 삭제 — 처리된 지시는 지울 수 없습니다' })
  remove(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.traces.remove(id, user);
  }
}
