import { Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import { ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../auth/auth.constants';
import { PostRoomChargeDto, VoidRoomChargeDto } from './dto/pos.dto';
import { POS_KEY_HEADER, PosKeyGuard, type PosRequest } from './pos-key.guard';
import { PosService } from './pos.service';

/**
 * 외부 POS 단말이 쓰는 API.
 *
 * `@Public()` 은 "인증이 없다" 가 아니라 "직원 JWT 를 쓰지 않는다" 는 뜻이다.
 * 인증은 PosKeyGuard 가 아웃렛 키로 한다 — 단말에 직원 비밀번호를 심지 않기
 * 위해서다.
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
