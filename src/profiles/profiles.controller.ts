import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import type { AuthUser } from '../auth/auth.constants';
import { Roles } from '../auth/auth.constants';
import { CurrentUser } from '../auth/current-user.decorator';
import { ListProfilesDto, MergeProfileDto, UpdateProfileDto } from './dto/profiles.dto';
import { ProfilesService } from './profiles.service';

@ApiTags('profiles')
@ApiBearerAuth()
@Controller('profiles')
export class ProfilesController {
  constructor(private readonly profiles: ProfilesService) {}

  // The first screen the front desk uses to find a guest.
  @Get()
  @Roles(UserRole.MANAGER, UserRole.FRONT_DESK)
  @ApiOperation({ summary: '프로필 검색 — 이름·이메일·전화·멤버십 번호' })
  list(@Query() query: ListProfilesDto) {
    return this.profiles.list(query);
  }

  @Get(':id')
  @Roles(UserRole.MANAGER, UserRole.FRONT_DESK)
  @ApiOperation({ summary: '프로필 상세 — 투숙 이력과 누적 실적 포함' })
  findOne(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.profiles.findOne(id, user);
  }

  @Get(':id/duplicates')
  @Roles(UserRole.MANAGER, UserRole.FRONT_DESK)
  @ApiOperation({ summary: '중복 후보 — 자동으로 합치지 않고 근거만 보여 줍니다' })
  duplicates(@Param('id') id: string) {
    return this.profiles.duplicates(id);
  }

  @Patch(':id')
  @Roles(UserRole.MANAGER, UserRole.FRONT_DESK)
  @ApiOperation({ summary: '프로필 수정 — 선호·멤버십·내부 메모' })
  update(@Param('id') id: string, @Body() dto: UpdateProfileDto) {
    return this.profiles.update(id, dto);
  }

  // A merge is hard to undo. Managers and above only.
  @Post(':id/merge')
  @Roles(UserRole.MANAGER)
  @ApiOperation({ summary: '중복 병합 — 이 프로필을 대상 프로필로 합칩니다' })
  merge(@Param('id') id: string, @Body() dto: MergeProfileDto) {
    return this.profiles.merge(id, dto.targetId);
  }
}
