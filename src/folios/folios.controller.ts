import { Body, Controller, Get, Param, ParseIntPipe, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import type { AuthUser } from '../auth/auth.constants';
import { Roles } from '../auth/auth.constants';
import { CurrentUser } from '../auth/current-user.decorator';
import { CreatePostingDto, OpenFolioDto } from './dto/folios.dto';
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
}
