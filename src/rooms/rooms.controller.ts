import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { AuthUser } from '../auth/auth.constants';
import { CurrentUser } from '../auth/current-user.decorator';
import { ListRoomsDto } from './dto/rooms.dto';
import { RoomsService } from './rooms.service';

/**
 * 객실 조회.
 *
 * 상태 변경은 OPERA 위임이 필요해 HousekeepingController 가 맡는다
 * (`PATCH /housekeeping/rooms/:id/status`). 조회와 쓰기를 나눠 둔 이유는,
 * 쓰기가 외부 시스템 호출을 동반하기 때문이다.
 */
@ApiTags('rooms')
@ApiBearerAuth()
@Controller('rooms')
export class RoomsController {
  constructor(private readonly rooms: RoomsService) {}

  // 조회는 하우스키핑을 포함한 모든 역할이 필요로 한다.
  @Get()
  @ApiOperation({ summary: '객실 목록 조회' })
  list(@Query() query: ListRoomsDto, @CurrentUser() user: AuthUser) {
    return this.rooms.list(query, user);
  }

  @Get('summary')
  @ApiOperation({ summary: '객실 상태별 집계' })
  summary(@Query('propertyId') propertyId: string, @CurrentUser() user: AuthUser) {
    return this.rooms.statusSummary(propertyId, user);
  }
}
