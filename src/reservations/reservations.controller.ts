import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
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
  UpdateBookingDto,
  ShareReservationDto,
} from './dto/booking.dto';
import { CheckInDto, CheckOutDto } from './dto/front-desk.dto';
import { ListReservationsDto } from './dto/list-reservations.dto';
import { ReservationsService } from './reservations.service';

@ApiTags('reservations')
@ApiBearerAuth()
// 하우스키핑은 객실만 다루므로 예약에는 접근하지 않는다. ADMIN 은 가드가 항상 통과시킨다.
@Roles(UserRole.MANAGER, UserRole.FRONT_DESK)
@Controller('reservations')
export class ReservationsController {
  constructor(
    private readonly reservations: ReservationsService,
    private readonly booking: BookingService,
  ) {}

  // --- OPERA 위임 --------------------------------------------------------
  // 재고와 요금은 계산하지 않고 OPERA 에 묻는다. 두 시스템이 각자 계산하면
  // 언젠가 값이 갈리고, 그때 어느 쪽이 맞는지 판단할 근거가 없다.

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

  // --- 로컬 조회·프론트데스크 -------------------------------------------
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
