import { Body, Controller, Delete, Get, Param, ParseIntPipe, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import type { AuthUser } from '../auth/auth.constants';
import { Roles } from '../auth/auth.constants';
import { CurrentUser } from '../auth/current-user.decorator';
import {
  CreatePostingDto,
  OpenFolioDto,
  RecordDepositDto,
  SetRoutingDto,
  TransferPostingDto,
} from './dto/folios.dto';
import { FoliosService } from './folios.service';

@ApiTags('folios')
@ApiBearerAuth()
// 회계 거래는 프론트데스크와 매니저만 다룬다.
@Roles(UserRole.MANAGER, UserRole.FRONT_DESK)
@Controller('reservations/:reservationId/folios')
export class FoliosController {
  constructor(private readonly folios: FoliosService) {}

  @Get()
  @ApiOperation({ summary: '예약의 폴리오와 거래 내역 조회' })
  list(@Param('reservationId') reservationId: string, @CurrentUser() user: AuthUser) {
    return this.folios.listByReservation(reservationId, user);
  }

  @Post()
  @ApiOperation({ summary: '폴리오 윈도 추가 개설 (분할 정산)' })
  openWindow(
    @Param('reservationId') reservationId: string,
    @Body() dto: OpenFolioDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.folios.openWindow(reservationId, dto, user);
  }

  /*
   * 보증금은 창구 번호를 받지 않는다.
   *
   * 도착 전에는 1번 창구뿐이고, 없으면 OPERA 가 연다. 번호를 고르게 두면 아직
   * 열리지도 않은 창구를 지정하는 실수가 생긴다.
   */
  @Post('deposit')
  @ApiOperation({ summary: '보증금 수납 — 도착 전에도 폴리오에 결제로 올립니다' })
  recordDeposit(
    @Param('reservationId') reservationId: string,
    @Body() dto: RecordDepositDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.folios.recordDeposit(reservationId, dto, user);
  }

  @Post(':window/postings')
  @ApiOperation({ summary: '청구·결제 등록 후 잔액 재계산' })
  addPosting(
    @Param('reservationId') reservationId: string,
    @Param('window', ParseIntPipe) window: number,
    @Body() dto: CreatePostingDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.folios.addPosting(reservationId, window, dto, user);
  }

  @Post('postings/:postingId/transfer')
  @ApiOperation({ summary: '거래를 다른 창구로 이관 — 양쪽 잔액을 다시 계산합니다' })
  transfer(
    @Param('reservationId') reservationId: string,
    @Param('postingId') postingId: string,
    @Body() dto: TransferPostingDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.folios.transferPosting(reservationId, postingId, dto, user);
  }

  @Get('routings')
  @ApiOperation({ summary: '라우팅 지시 조회' })
  listRoutings(@Param('reservationId') reservationId: string, @CurrentUser() user: AuthUser) {
    return this.folios.listRoutings(reservationId, user);
  }

  @Post('routings')
  @ApiOperation({ summary: '라우팅 지시 설정 — 거래 코드별 목적지 창구' })
  setRouting(
    @Param('reservationId') reservationId: string,
    @Body() dto: SetRoutingDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.folios.setRouting(reservationId, dto, user);
  }

  @Delete('routings/:transactionCode')
  @ApiOperation({ summary: '라우팅 지시 해제' })
  removeRouting(
    @Param('reservationId') reservationId: string,
    @Param('transactionCode') transactionCode: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.folios.removeRouting(reservationId, transactionCode, user);
  }
}
