import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import type { AuthUser } from '../auth/auth.constants';
import { Roles } from '../auth/auth.constants';
import { CurrentUser } from '../auth/current-user.decorator';
import { CreatePropertyDto, ListPropertiesDto, UpdatePropertyDto } from './dto/properties.dto';
import { PropertiesService } from './properties.service';
import { assertWithinScope } from './property-scope';

@ApiTags('properties')
@ApiBearerAuth()
@Controller('properties')
export class PropertiesController {
  constructor(private readonly properties: PropertiesService) {}

  // Every role reads the list — it is needed to draw the hotel picker.
  // Accounts with a property get only their own hotel back.
  @Get()
  @ApiOperation({ summary: '접근 가능한 호텔 목록' })
  list(@CurrentUser() user: AuthUser, @Query() query: ListPropertiesDto) {
    return this.properties.list(user, query.includeInactive);
  }

  @Get(':id')
  @ApiOperation({ summary: '호텔 단건 조회' })
  async findOne(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    const property = await this.properties.findOne(id);
    assertWithinScope(user, property.id);
    return property;
  }

  @Get(':id/room-types')
  @ApiOperation({ summary: '호텔의 객실 타입 목록' })
  roomTypes(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.properties.listRoomTypes(id, user);
  }

  @Post()
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: '호텔 등록' })
  create(@Body() dto: CreatePropertyDto) {
    return this.properties.create(dto);
  }

  @Patch(':id')
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: '호텔 수정 — 운영 중단은 active=false 로 합니다' })
  update(@Param('id') id: string, @Body() dto: UpdatePropertyDto) {
    return this.properties.update(id, dto);
  }
}
