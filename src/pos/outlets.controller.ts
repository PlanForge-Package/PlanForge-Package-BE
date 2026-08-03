import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import type { AuthUser } from '../auth/auth.constants';
import { Roles } from '../auth/auth.constants';
import { CurrentUser } from '../auth/current-user.decorator';
import { CreateOutletDto, UpdateOutletDto } from './dto/pos.dto';
import { OutletsService } from './outlets.service';

@ApiTags('pos-outlets')
@ApiBearerAuth()
@Controller('pos-outlets')
export class OutletsController {
  constructor(private readonly outlets: OutletsService) {}

  // 아웃렛 키는 요금을 달 수 있는 자격이다. 지배인 이상만 다룬다.
  @Get()
  @Roles(UserRole.MANAGER)
  @ApiOperation({ summary: 'POS 아웃렛 목록' })
  list(@Query('propertyId') propertyId: string, @CurrentUser() user: AuthUser) {
    return this.outlets.list(propertyId, user);
  }

  @Post()
  @Roles(UserRole.MANAGER)
  @ApiOperation({ summary: '아웃렛 등록 — 발급된 키는 이 응답에서만 볼 수 있습니다' })
  create(@Body() dto: CreateOutletDto, @CurrentUser() user: AuthUser) {
    return this.outlets.create(dto, user);
  }

  @Patch(':id')
  @Roles(UserRole.MANAGER)
  @ApiOperation({ summary: '아웃렛 수정 — 이름·거래 코드·사용 여부' })
  update(@Param('id') id: string, @Body() dto: UpdateOutletDto, @CurrentUser() user: AuthUser) {
    return this.outlets.update(id, dto, user);
  }

  @Post(':id/rotate-key')
  @Roles(UserRole.MANAGER)
  @ApiOperation({ summary: '키 재발급 — 이전 키는 즉시 통하지 않습니다' })
  rotate(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.outlets.rotateKey(id, user);
  }
}
