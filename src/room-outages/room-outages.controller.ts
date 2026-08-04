import { Body, Controller, Delete, Get, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import type { AuthUser } from '../auth/auth.constants';
import { Roles } from '../auth/auth.constants';
import { CurrentUser } from '../auth/current-user.decorator';
import {
  CreateRoomOutageDto,
  ListRoomOutagesDto,
  ReleaseRoomOutageDto,
} from './dto/room-outages.dto';
import { RoomOutagesService } from './room-outages.service';

/**
 * Room outages.
 *
 * Every role may read — housekeeping and the front desk both need to know which
 * rooms are out today. Registering and releasing cuts inventory, so managers and the front desk only.
 */
@ApiTags('room-outages')
@ApiBearerAuth()
@Controller('room-outages')
export class RoomOutagesController {
  constructor(private readonly outages: RoomOutagesService) {}

  @Get()
  @ApiOperation({ summary: '사용 불가 객실 목록' })
  list(@Query() query: ListRoomOutagesDto, @CurrentUser() user: AuthUser) {
    return this.outages.list(query, user);
  }

  @Post()
  @Roles(UserRole.MANAGER, UserRole.FRONT_DESK)
  @ApiOperation({ summary: '객실을 사용 불가로 등록 — OPERA 에 먼저 반영합니다' })
  create(@Body() dto: CreateRoomOutageDto, @CurrentUser() user: AuthUser) {
    return this.outages.create(dto, user);
  }

  @Delete(':id')
  @Roles(UserRole.MANAGER, UserRole.FRONT_DESK)
  @ApiOperation({ summary: '사용 불가 해제 — 객실을 다시 판매합니다' })
  release(
    @Param('id') id: string,
    @Body() dto: ReleaseRoomOutageDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.outages.release(id, dto, user);
  }
}
