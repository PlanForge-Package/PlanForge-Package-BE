import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import type { AuthUser } from '../auth/auth.constants';
import { Roles } from '../auth/auth.constants';
import { CurrentUser } from '../auth/current-user.decorator';
import { CheckInDto, CheckOutDto } from './dto/front-desk.dto';
import { ListReservationsDto } from './dto/list-reservations.dto';
import { ReservationsService } from './reservations.service';

@ApiTags('reservations')
@ApiBearerAuth()
// 하우스키핑은 객실만 다루므로 예약에는 접근하지 않는다. ADMIN 은 가드가 항상 통과시킨다.
@Roles(UserRole.MANAGER, UserRole.FRONT_DESK)
@Controller('reservations')
export class ReservationsController {
  constructor(private readonly reservations: ReservationsService) {}

  // 모든 조회·조작에 요청자를 함께 넘긴다. 소속이 지정된 직원은 자기 호텔로 고정된다.
  @Get()
  @ApiOperation({ summary: '예약 목록 조회' })
  list(@Query() query: ListReservationsDto, @CurrentUser() user: AuthUser) {
    return this.reservations.list(query, user);
  }

  @Get('summary')
  @ApiOperation({ summary: '당일 도착·출발·재실 요약' })
  summary(
    @Query('propertyId') propertyId: string,
    @Query('date') date: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.reservations.dailySummary(propertyId, date, user);
  }

  @Get(':id')
  @ApiOperation({ summary: '예약 단건 조회 (폴리오 포함)' })
  findOne(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.reservations.findOne(id, user);
  }

  @Post(':id/check-in')
  @ApiOperation({ summary: '체크인 — 객실 배정 및 폴리오 개설' })
  checkIn(@Param('id') id: string, @Body() dto: CheckInDto, @CurrentUser() user: AuthUser) {
    return this.reservations.checkIn(id, dto, user);
  }

  @Post(':id/check-out')
  @ApiOperation({ summary: '체크아웃 — 폴리오 마감 및 객실 반납' })
  checkOut(@Param('id') id: string, @Body() dto: CheckOutDto, @CurrentUser() user: AuthUser) {
    return this.reservations.checkOut(id, dto, user);
  }
}
