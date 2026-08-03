import { Body, Controller, Get, Param, Patch, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { Roles } from '../auth/auth.constants';
import { ListRoomsDto, UpdateRoomStatusDto } from './dto/rooms.dto';
import { RoomsService } from './rooms.service';

@ApiTags('rooms')
@ApiBearerAuth()
@Controller('rooms')
export class RoomsController {
  constructor(private readonly rooms: RoomsService) {}

  // 조회는 하우스키핑을 포함한 모든 역할이 필요로 한다.
  @Get()
  @ApiOperation({ summary: '객실 목록 조회' })
  list(@Query() query: ListRoomsDto) {
    return this.rooms.list(query);
  }

  @Get('summary')
  @ApiOperation({ summary: '객실 상태별 집계' })
  summary(@Query('propertyId') propertyId: string) {
    return this.rooms.statusSummary(propertyId);
  }

  @Patch(':id/status')
  @Roles(UserRole.MANAGER, UserRole.FRONT_DESK, UserRole.HOUSEKEEPING)
  @ApiOperation({ summary: '하우스키핑 상태 변경' })
  updateStatus(@Param('id') id: string, @Body() dto: UpdateRoomStatusDto) {
    return this.rooms.updateStatus(id, dto);
  }
}
