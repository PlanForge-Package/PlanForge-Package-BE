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

  // 하우스키핑 직원이 자기 작업을 보는 화면이므로 전 역할이 조회한다.
  // 서비스가 역할에 따라 범위를 좁힌다.
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

  // 진행 처리는 담당 직원이 직접 한다. 서비스가 본인 작업인지 확인한다.
  @Patch('tasks/:id')
  @ApiOperation({ summary: '작업 진행 상태 변경' })
  update(@Param('id') id: string, @Body() dto: UpdateTaskDto, @CurrentUser() user: AuthUser) {
    return this.housekeeping.updateTask(id, dto, user);
  }

  /**
   * 객실 상태 변경.
   *
   * 하우스키핑도 바꿀 수 있어야 한다 — 청소를 끝낸 사람이 상태를 올리는 것이
   * 자연스러운 흐름이다. 실제 반영은 OPERA 가 한다.
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
