import { Body, Controller, Get, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import type { AuthUser } from '../auth/auth.constants';
import { Roles } from '../auth/auth.constants';
import { CurrentUser } from '../auth/current-user.decorator';
import { BookingService } from './booking.service';
import {
  CancelBookingDto,
  CheckAvailabilityDto,
  CreateBookingDto,
  SetGuaranteeDto,
  ShareReservationDto,
  UpdateBookingDto,
} from './dto/booking.dto';
import { CheckInDto, CheckOutDto } from './dto/front-desk.dto';
import { ListReservationsDto } from './dto/list-reservations.dto';
import { ReservationsService } from './reservations.service';

@ApiTags('reservations')
@ApiBearerAuth()
// Housekeeping only handles rooms, so it has no reservation access. ADMIN always passes the guard.
@Roles(UserRole.MANAGER, UserRole.FRONT_DESK)
@Controller('reservations')
export class ReservationsController {
  constructor(
    private readonly reservations: ReservationsService,
    private readonly booking: BookingService,
  ) {}

  // --- Delegated to OPERA ------------------------------------------------
  // Inventory and rates are asked of OPERA rather than computed. Two systems
  // computing separately eventually disagree, with no way to tell which is right.

  @Get('availability')
  @ApiOperation({ summary: '가용 재고 조회 (OPERA)' })
  availability(@Query() query: CheckAvailabilityDto, @CurrentUser() user: AuthUser) {
    return this.booking.checkAvailability(query, user);
  }

  @Get('rates')
  @ApiOperation({ summary: '기간 요금 조회 (OPERA)' })
  rates(@Query() query: CheckAvailabilityDto, @CurrentUser() user: AuthUser) {
    return this.booking.getRates(query, user);
  }

  @Post()
  @ApiOperation({ summary: '예약 생성 — OPERA 에 만들고 로컬에 미러링' })
  create(@Body() dto: CreateBookingDto, @CurrentUser() user: AuthUser) {
    return this.booking.create(dto, user);
  }

  @Patch(':id')
  @ApiOperation({ summary: '예약 수정 — 날짜·객실 타입·인원' })
  update(@Param('id') id: string, @Body() dto: UpdateBookingDto, @CurrentUser() user: AuthUser) {
    return this.booking.update(id, dto, user);
  }

  @Post(':id/cancel')
  @ApiOperation({ summary: '예약 취소' })
  cancel(@Param('id') id: string, @Body() dto: CancelBookingDto, @CurrentUser() user: AuthUser) {
    return this.booking.cancel(id, dto, user);
  }

  // The guest has to hear this before we cancel. Telling them after charging is a settlement.
  @Get(':id/policies')
  @ApiOperation({ summary: '취소 조건·보증금 — 취소 시 물게 될 금액' })
  policies(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.booking.policies(id, user);
  }

  @Put(':id/guarantee')
  @ApiOperation({ summary: '보증 방식 변경 — 노쇼를 어떻게 다룰지가 갈립니다' })
  setGuarantee(
    @Param('id') id: string,
    @Body() dto: SetGuaranteeDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.booking.setGuarantee(id, dto.guaranteeCode, user);
  }

  @Post(':id/share')
  @ApiOperation({ summary: '객실 공유 — 두 예약이 한 방을 쓰고 계산은 따로 합니다' })
  share(@Param('id') id: string, @Body() dto: ShareReservationDto, @CurrentUser() user: AuthUser) {
    return this.booking.share(id, dto.withReservationId, user);
  }

  @Post(':id/unshare')
  @ApiOperation({ summary: '공유 해제 — 이 예약만 묶음에서 뺍니다' })
  unshare(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.booking.unshare(id, user);
  }

  @Post(':id/confirm-waitlist')
  @ApiOperation({ summary: '대기 확정 — 확정 시점에 OPERA 가 재고를 다시 봅니다' })
  confirmWaitlist(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.booking.confirmWaitlist(id, user);
  }

  // --- Local reads and front desk ----------------------------------------
  // Every read and action carries the requester. Staff with a property are fixed to their hotel.
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
