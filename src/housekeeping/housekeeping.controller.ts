import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import type { AuthUser } from '../auth/auth.constants';
import { Roles } from '../auth/auth.constants';
import { CurrentUser } from '../auth/current-user.decorator';
import {
  AssignTaskDto,
  GenerateTasksDto,
  ListTasksDto,
  UpdateRoomStatusDto,
  UpdateTaskDto,
} from './dto/housekeeping.dto';
import { HousekeepingService } from './housekeeping.service';

@ApiTags('housekeeping')
@ApiBearerAuth()
@Controller('housekeeping')
export class HousekeepingController {
  constructor(private readonly housekeeping: HousekeepingService) {}

  // Housekeeping staff view their own work here, so every role may read it.
  // The service narrows the scope by role.
  @Get('tasks')
  @ApiOperation({ summary: '근무일 작업 목록 — 하우스키핑은 본인 것만 보입니다' })
  listTasks(@Query() query: ListTasksDto, @CurrentUser() user: AuthUser) {
    return this.housekeeping.listTasks(query, user);
  }

  @Get('attendants')
  @Roles(UserRole.MANAGER, UserRole.FRONT_DESK)
  @ApiOperation({ summary: '배정 가능한 하우스키핑 직원' })
  attendants(@Query('propertyId') propertyId: string, @CurrentUser() user: AuthUser) {
    return this.housekeeping.listAttendants(propertyId, user);
  }

  @Post('tasks/generate')
  @Roles(UserRole.MANAGER, UserRole.FRONT_DESK)
  @ApiOperation({ summary: '근무일 작업 생성 — 청소 필요·재실 객실 대상' })
  generate(@Body() dto: GenerateTasksDto, @CurrentUser() user: AuthUser) {
    return this.housekeeping.generateTasks(dto, user);
  }

  @Patch('tasks/:id/assign')
  @Roles(UserRole.MANAGER, UserRole.FRONT_DESK)
  @ApiOperation({ summary: '작업 배정 — 비우면 배정 해제' })
  assign(@Param('id') id: string, @Body() dto: AssignTaskDto, @CurrentUser() user: AuthUser) {
    return this.housekeeping.assignTask(id, dto, user);
  }

  // Progress is recorded by the assigned person. The service checks it is their task.
  @Patch('tasks/:id')
  @ApiOperation({ summary: '작업 진행 상태 변경' })
  update(@Param('id') id: string, @Body() dto: UpdateTaskDto, @CurrentUser() user: AuthUser) {
    return this.housekeeping.updateTask(id, dto, user);
  }

  /**
   * Room status change.
   *
   * Housekeeping must be able to change it too — whoever finished cleaning raising
   * the status is the natural flow. OPERA applies the change.
   */
  @Patch('rooms/:id/status')
  @Roles(UserRole.MANAGER, UserRole.FRONT_DESK, UserRole.HOUSEKEEPING)
  @ApiOperation({ summary: '객실 상태 변경 — OPERA 에 반영 후 미러링' })
  updateRoomStatus(
    @Param('id') id: string,
    @Body() dto: UpdateRoomStatusDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.housekeeping.updateRoomStatus(id, dto, user);
  }

  @Get('discrepancies')
  @Roles(UserRole.MANAGER, UserRole.FRONT_DESK, UserRole.HOUSEKEEPING)
  @ApiOperation({ summary: '객실 상태와 재실이 어긋난 곳' })
  discrepancies(@Query('propertyId') propertyId: string, @CurrentUser() user: AuthUser) {
    return this.housekeeping.findDiscrepancies(propertyId, user);
  }
}
