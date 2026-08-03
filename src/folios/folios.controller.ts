import { Body, Controller, Get, Param, ParseIntPipe, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CreatePostingDto, OpenFolioDto } from './dto/folios.dto';
import { FoliosService } from './folios.service';

@ApiTags('folios')
@Controller('reservations/:reservationId/folios')
export class FoliosController {
  constructor(private readonly folios: FoliosService) {}

  @Get()
  @ApiOperation({ summary: '예약의 폴리오와 거래 내역 조회' })
  list(@Param('reservationId') reservationId: string) {
    return this.folios.listByReservation(reservationId);
  }

  @Post()
  @ApiOperation({ summary: '폴리오 윈도 추가 개설 (분할 정산)' })
  openWindow(@Param('reservationId') reservationId: string, @Body() dto: OpenFolioDto) {
    return this.folios.openWindow(reservationId, dto);
  }

  @Post(':window/postings')
  @ApiOperation({ summary: '청구·결제 등록 후 잔액 재계산' })
  addPosting(
    @Param('reservationId') reservationId: string,
    @Param('window', ParseIntPipe) window: number,
    @Body() dto: CreatePostingDto,
  ) {
    return this.folios.addPosting(reservationId, window, dto);
  }
}
