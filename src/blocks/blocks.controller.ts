import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import type { AuthUser } from '../auth/auth.constants';
import { Roles } from '../auth/auth.constants';
import { CurrentUser } from '../auth/current-user.decorator';
import { BlocksService } from './blocks.service';
import { CreateBlockDto, ListBlocksDto, UpdateBlockDto } from './dto/blocks.dto';

@ApiTags('blocks')
@ApiBearerAuth()
@Controller('blocks')
export class BlocksController {
  constructor(private readonly blocks: BlocksService) {}

  // 조회는 프런트도 필요하다 — 단체 손님이 도착하면 어느 블록인지 확인해야 한다.
  @Get()
  @Roles(UserRole.MANAGER, UserRole.FRONT_DESK)
  @ApiOperation({ summary: '단체 블록 목록 — OPERA 조회 후 미러링' })
  list(@Query() query: ListBlocksDto, @CurrentUser() user: AuthUser) {
    return this.blocks.list(query, user);
  }

  @Get(':id')
  @Roles(UserRole.MANAGER, UserRole.FRONT_DESK)
  @ApiOperation({ summary: '블록 상세 — 일자·객실 타입별 할당과 픽업' })
  get(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.blocks.get(id, user);
  }

  @Get(':id/reservations')
  @Roles(UserRole.MANAGER, UserRole.FRONT_DESK)
  @ApiOperation({ summary: '룸리스트 — 이 블록에서 빠져나간 예약' })
  roomingList(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.blocks.roomingList(id, user);
  }

  // 블록 생성·수정은 재고를 잡는 행위라 프런트 데스크 권한 밖이다.
  @Post()
  @Roles(UserRole.MANAGER)
  @ApiOperation({ summary: '블록 생성 — 재고 확보는 OPERA 가 판단합니다' })
  create(@Body() dto: CreateBlockDto, @CurrentUser() user: AuthUser) {
    return this.blocks.create(dto, user);
  }

  @Patch(':id')
  @Roles(UserRole.MANAGER)
  @ApiOperation({ summary: '블록 수정 — 이름·상태·컷오프' })
  update(@Param('id') id: string, @Body() dto: UpdateBlockDto, @CurrentUser() user: AuthUser) {
    return this.blocks.update(id, dto, user);
  }
}
