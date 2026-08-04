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
 * 사용 불가 객실.
 *
 * 조회는 전 역할이 한다 — 하우스키핑도 프론트도 오늘 어느 방을 못 쓰는지 알아야
 * 한다. 등록·해제는 재고를 줄이는 결정이므로 지배인과 프론트데스크만 한다.
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
