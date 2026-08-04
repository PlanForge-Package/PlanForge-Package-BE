import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import type { AuthUser } from '../auth/auth.constants';
import { Roles } from '../auth/auth.constants';
import { CurrentUser } from '../auth/current-user.decorator';
import { CreateUserDto, ListUsersDto, ResetPasswordDto, UpdateUserDto } from './dto/users.dto';
import { UsersService } from './users.service';

@ApiTags('users')
@ApiBearerAuth()
// Account management is admin-only. Being able to change a role is being able to grant anything.
@Roles(UserRole.ADMIN)
@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  @ApiOperation({ summary: '계정 목록 조회' })
  list(@Query() query: ListUsersDto) {
    return this.users.list(query);
  }

  @Get(':id')
  @ApiOperation({ summary: '계정 단건 조회' })
  findOne(@Param('id') id: string) {
    return this.users.findOne(id);
  }

  @Post()
  @ApiOperation({ summary: '계정 생성 (입사)' })
  create(@Body() dto: CreateUserDto) {
    return this.users.create(dto);
  }

  @Patch(':id')
  @ApiOperation({ summary: '계정 수정 — 퇴사 처리는 active=false 로 합니다' })
  update(@Param('id') id: string, @Body() dto: UpdateUserDto, @CurrentUser() actor: AuthUser) {
    return this.users.update(id, dto, actor.id);
  }

  @Post(':id/password')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '비밀번호 초기화 (관리자)' })
  resetPassword(@Param('id') id: string, @Body() dto: ResetPasswordDto) {
    return this.users.resetPassword(id, dto);
  }
}
