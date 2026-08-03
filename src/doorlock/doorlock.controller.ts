import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import type { AuthUser } from '../auth/auth.constants';
import { Roles } from '../auth/auth.constants';
import { CurrentUser } from '../auth/current-user.decorator';
import { DoorLockService } from './doorlock.service';
import { IssueKeyDto, RevokeKeyDto } from './dto/doorlock.dto';

@ApiTags('door-keys')
@ApiBearerAuth()
@Controller()
export class DoorLockController {
  constructor(private readonly doorLock: DoorLockService) {}

  // 카드 발급은 프런트데스크의 일상 업무다.
  @Get('reservations/:id/keys')
  @Roles(UserRole.MANAGER, UserRole.FRONT_DESK)
  @ApiOperation({ summary: '이 예약에 발급된 카드 이력' })
  list(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.doorLock.listByReservation(id, user);
  }

  @Post('reservations/:id/keys')
  @Roles(UserRole.MANAGER, UserRole.FRONT_DESK)
  @ApiOperation({ summary: '카드 발급 — 기본으로 이전 카드를 무효화합니다' })
  issue(@Param('id') id: string, @Body() dto: IssueKeyDto, @CurrentUser() user: AuthUser) {
    return this.doorLock.issue(id, dto, user);
  }

  @Post('door-keys/:keyId/revoke')
  @Roles(UserRole.MANAGER, UserRole.FRONT_DESK)
  @ApiOperation({ summary: '카드 무효화 — 분실 신고 시' })
  revoke(@Param('keyId') keyId: string, @Body() dto: RevokeKeyDto, @CurrentUser() user: AuthUser) {
    return this.doorLock.revoke(keyId, dto, user);
  }
}
