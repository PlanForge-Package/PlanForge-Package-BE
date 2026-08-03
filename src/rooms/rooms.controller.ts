import { Body, Controller, Get, Param, Patch, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ListRoomsDto, UpdateRoomStatusDto } from './dto/rooms.dto';
import { RoomsService } from './rooms.service';

@ApiTags('rooms')
@Controller('rooms')
export class RoomsController {
  constructor(private readonly rooms: RoomsService) {}

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
  @ApiOperation({ summary: '하우스키핑 상태 변경' })
  updateStatus(@Param('id') id: string, @Body() dto: UpdateRoomStatusDto) {
    return this.rooms.updateStatus(id, dto);
  }
}
