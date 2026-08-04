import { Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import { ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../auth/auth.constants';
import { PostRoomChargeDto, VoidRoomChargeDto } from './dto/pos.dto';
import { POS_KEY_HEADER, PosKeyGuard, type PosRequest } from './pos-key.guard';
import { PosService } from './pos.service';

/**
 * API used by outside POS terminals.
 *
 * `@Public()` does not mean unauthenticated; it means no staff JWT is used.
 * PosKeyGuard authenticates with the outlet key instead — so that no staff password
 * ever lives in a terminal.
 */
@ApiTags('pos')
@ApiHeader({ name: POS_KEY_HEADER, description: '아웃렛 API 키', required: true })
@Controller('pos')
@Public()
@UseGuards(PosKeyGuard)
export class PosController {
  constructor(private readonly pos: PosService) {}

  @Get('rooms')
  @ApiOperation({ summary: '요금을 달 수 있는 재실 객실 — 객실 번호와 성만' })
  rooms(@Req() request: PosRequest) {
    return this.pos.chargeableRooms(request.outlet);
  }

  @Post('charges')
  @ApiOperation({ summary: '룸차지 — 같은 전표는 한 번만 달립니다' })
  charge(@Req() request: PosRequest, @Body() dto: PostRoomChargeDto) {
    return this.pos.postCharge(request.outlet, dto);
  }

  @Post('charges/void')
  @ApiOperation({ summary: '룸차지 취소 — 원본을 지우지 않고 반대 조정을 답니다' })
  void(@Req() request: PosRequest, @Body() dto: VoidRoomChargeDto) {
    return this.pos.voidCharge(request.outlet, dto);
  }
}
