import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { SyncStatus, UserRole } from '@prisma/client';
import { Roles } from '../auth/auth.constants';
import { PrismaService } from '../prisma/prisma.service';
import { SyncReservationsDto } from './dto/sync-reservations.dto';
import { SyncService, type SyncReservationsResult } from './sync.service';

@ApiTags('sync')
@ApiBearerAuth()
// OPERA sync is a bulk write, so managers and above only.
@Roles(UserRole.MANAGER)
@Controller('sync')
export class SyncController {
  constructor(
    private readonly sync: SyncService,
    private readonly prisma: PrismaService,
  ) {}

  @Post('reservations')
  @ApiOperation({ summary: 'Core 를 통해 OPERA 예약을 끌어와 로컬 DB 에 반영' })
  syncReservations(@Body() dto: SyncReservationsDto): Promise<SyncReservationsResult> {
    return this.sync.syncReservations(dto);
  }

  @Get('logs')
  @ApiOperation({ summary: '최근 동기화 이력 조회' })
  logs(@Query('status') status?: SyncStatus) {
    return this.prisma.syncLog.findMany({
      where: status ? { status } : undefined,
      orderBy: { startedAt: 'desc' },
      take: 50,
    });
  }
}
