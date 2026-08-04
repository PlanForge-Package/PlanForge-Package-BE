import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import type { AuthUser } from '../auth/auth.constants';
import { Roles } from '../auth/auth.constants';
import { CurrentUser } from '../auth/current-user.decorator';
import {
  CreatePackageDto,
  CreateRatePlanDto,
  CreateSeasonDto,
  DeleteSeasonDto,
  ListPackagesDto,
  ListRatePlansDto,
  QuoteRatesDto,
  UpdatePackageDto,
  UpdateRatePlanDto,
} from './dto/rates.dto';
import { RatesService } from './rates.service';

/**
 * 요금 코드·시즌·패키지.
 *
 * 조회는 프론트도 한다 — 예약을 받으려면 무엇을 얼마에 파는지 봐야 한다.
 * 설정 변경은 매출에 직결되므로 지배인 이상만 한다.
 */
@ApiTags('rates')
@ApiBearerAuth()
@Roles(UserRole.MANAGER, UserRole.FRONT_DESK)
@Controller('rates')
export class RatesController {
  constructor(private readonly rates: RatesService) {}

  @Get('quote')
  @ApiOperation({ summary: '기간 요금 조회 — 일자별 단가와 패키지 포함' })
  quote(@Query() query: QuoteRatesDto, @CurrentUser() user: AuthUser) {
    return this.rates.quote(query, user);
  }

  @Get('plans')
  @ApiOperation({ summary: '요금 코드 목록' })
  listPlans(@Query() query: ListRatePlansDto, @CurrentUser() user: AuthUser) {
    return this.rates.listPlans(query, user);
  }

  @Get('plans/:ratePlanCode')
  @ApiOperation({ summary: '요금 코드 단건 — 시즌과 패키지 포함' })
  getPlan(
    @Param('ratePlanCode') ratePlanCode: string,
    @Query() query: ListRatePlansDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.rates.getPlan(ratePlanCode, query, user);
  }

  @Post('plans')
  @Roles(UserRole.MANAGER)
  @ApiOperation({ summary: '요금 코드 등록 — OPERA 에 먼저 반영합니다' })
  createPlan(@Body() dto: CreateRatePlanDto, @CurrentUser() user: AuthUser) {
    return this.rates.createPlan(dto, user);
  }

  @Patch('plans/:ratePlanCode')
  @Roles(UserRole.MANAGER)
  @ApiOperation({ summary: '요금 코드 수정 — 판매 기간·기준 요금·패키지·중지' })
  updatePlan(
    @Param('ratePlanCode') ratePlanCode: string,
    @Body() dto: UpdateRatePlanDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.rates.updatePlan(ratePlanCode, dto, user);
  }

  @Post('plans/:ratePlanCode/seasons')
  @Roles(UserRole.MANAGER)
  @ApiOperation({ summary: '시즌 요금 추가 — 기간·요일로 기준 요금을 덮어씁니다' })
  addSeason(
    @Param('ratePlanCode') ratePlanCode: string,
    @Body() dto: CreateSeasonDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.rates.addSeason(ratePlanCode, dto, user);
  }

  @Delete('plans/:ratePlanCode/seasons/:seasonId')
  @Roles(UserRole.MANAGER)
  @ApiOperation({ summary: '시즌 요금 삭제 — 기준 요금으로 돌아갑니다' })
  removeSeason(
    @Param('ratePlanCode') ratePlanCode: string,
    @Param('seasonId') seasonId: string,
    @Body() dto: DeleteSeasonDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.rates.removeSeason(ratePlanCode, seasonId, dto.propertyId, user);
  }

  @Get('packages')
  @ApiOperation({ summary: '패키지 목록' })
  listPackages(@Query() query: ListPackagesDto, @CurrentUser() user: AuthUser) {
    return this.rates.listPackages(query, user);
  }

  @Post('packages')
  @Roles(UserRole.MANAGER)
  @ApiOperation({ summary: '패키지 등록' })
  createPackage(@Body() dto: CreatePackageDto, @CurrentUser() user: AuthUser) {
    return this.rates.createPackage(dto, user);
  }

  @Patch('packages/:packageCode')
  @Roles(UserRole.MANAGER)
  @ApiOperation({ summary: '패키지 수정' })
  updatePackage(
    @Param('packageCode') packageCode: string,
    @Body() dto: UpdatePackageDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.rates.updatePackage(packageCode, dto, user);
  }
}
