import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { AuthUser } from '../auth/auth.constants';
import { CurrentUser } from '../auth/current-user.decorator';
import { ListRoomsDto } from './dto/rooms.dto';
import { RoomsService } from './rooms.service';

/**
 * Room reads.
 *
 * Status changes need delegation to OPERA, so HousekeepingController owns them
 * (`PATCH /housekeeping/rooms/:id/status`). Reads and writes are split because
 * writes carry an external system call.
 */
@ApiTags('rooms')
@ApiBearerAuth()
@Controller('rooms')
export class RoomsController {
  constructor(private readonly rooms: RoomsService) {}

  // Reads are needed by every role, housekeeping included.
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
