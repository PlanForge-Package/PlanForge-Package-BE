import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, SyncDirection, SyncStatus, type Property } from '@prisma/client';
import type { AuthUser } from '../auth/auth.constants';
import { CoreClient } from '../core/core.client';
import type { CorePackage, CoreRatePlan } from '../core/core.types';
import { PrismaService } from '../prisma/prisma.service';
import { resolvePropertyScope } from '../properties/property-scope';
import type {
  CreatePackageDto,
  CreateRatePlanDto,
  CreateSeasonDto,
  ListPackagesDto,
  ListRatePlansDto,
  QuoteRatesDto,
  UpdatePackageDto,
  UpdateRatePlanDto,
} from './dto/rates.dto';

/**
 * 요금 코드·시즌·패키지.
 *
 * 요금은 OPERA 가 정한다 — 시즌·요일·프로모션·수익관리가 얽힌 결과라 우리가
 * 따로 계산하면 실제로 청구되는 금액과 갈린다. 그래서 사본을 두지 않고 매번
 * 저쪽 설정을 읽어 온다.
 *
 * 설정은 자주 바뀌지 않지만 틀리면 모든 예약의 금액이 틀어진다. 그래서 캐시로
 * 얻는 속도보다 "지금 OPERA 에 있는 값" 이 더 중요하다.
 */
@Injectable()
export class RatesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly core: CoreClient,
  ) {}

  // --- 조회 -----------------------------------------------------------------

  async quote(query: QuoteRatesDto, user: AuthUser) {
    const property = await this.resolveProperty(query.propertyId, user);

    if (query.departureDate <= query.arrivalDate) {
      throw new BadRequestException('출발일은 도착일보다 뒤여야 합니다.');
    }

    const result = await this.core.getRates({
      hotelId: property.operaHotelId,
      arrivalDate: query.arrivalDate,
      departureDate: query.departureDate,
      roomTypeCode: query.roomTypeCode,
      ratePlanCode: query.ratePlanCode,
      adults: query.adults,
    });

    return { propertyId: property.id, ...result };
  }

  async listPlans(query: ListRatePlansDto, user: AuthUser) {
    const property = await this.resolveProperty(query.propertyId, user);
    const result = await this.core.listRatePlans(property.operaHotelId, query.status);

    return { propertyId: property.id, items: result.items };
  }

  async getPlan(ratePlanCode: string, query: ListRatePlansDto, user: AuthUser) {
    const property = await this.resolveProperty(query.propertyId, user);
    return this.core.getRatePlan(ratePlanCode, property.operaHotelId);
  }

  async listPackages(query: ListPackagesDto, user: AuthUser) {
    const property = await this.resolveProperty(query.propertyId, user);
    const result = await this.core.listPackages(property.operaHotelId);

    return { propertyId: property.id, items: result.items };
  }

  // --- 요금 코드 -------------------------------------------------------------

  async createPlan(dto: CreateRatePlanDto, user: AuthUser): Promise<CoreRatePlan> {
    const property = await this.resolveProperty(dto.propertyId, user);
    const baseAmounts = await this.checkAmounts(property, dto.baseAmounts);

    if (dto.sellEndDate < dto.sellStartDate) {
      throw new BadRequestException('판매 종료일은 시작일보다 뒤여야 합니다.');
    }

    return this.delegate('createRatePlan', dto.ratePlanCode, () =>
      this.core.createRatePlan({
        hotelId: property.operaHotelId,
        ratePlanCode: dto.ratePlanCode.trim().toUpperCase(),
        name: dto.name.trim(),
        description: dto.description,
        currency: property.currency,
        marketCode: dto.marketCode,
        sellStartDate: dto.sellStartDate,
        sellEndDate: dto.sellEndDate,
        baseAmounts,
        packageCodes: dto.packageCodes,
        status: dto.status,
      }),
    );
  }

  async updatePlan(
    ratePlanCode: string,
    dto: UpdateRatePlanDto,
    user: AuthUser,
  ): Promise<CoreRatePlan> {
    const property = await this.resolveProperty(dto.propertyId, user);
    const baseAmounts = dto.baseAmounts
      ? await this.checkAmounts(property, dto.baseAmounts)
      : undefined;

    if (dto.sellStartDate && dto.sellEndDate && dto.sellEndDate < dto.sellStartDate) {
      throw new BadRequestException('판매 종료일은 시작일보다 뒤여야 합니다.');
    }

    return this.delegate('updateRatePlan', ratePlanCode, () =>
      this.core.updateRatePlan(ratePlanCode, {
        hotelId: property.operaHotelId,
        name: dto.name?.trim(),
        description: dto.description,
        marketCode: dto.marketCode,
        sellStartDate: dto.sellStartDate,
        sellEndDate: dto.sellEndDate,
        ...(baseAmounts ? { baseAmounts } : {}),
        packageCodes: dto.packageCodes,
        status: dto.status,
      }),
    );
  }

  // --- 시즌 -----------------------------------------------------------------

  async addSeason(
    ratePlanCode: string,
    dto: CreateSeasonDto,
    user: AuthUser,
  ): Promise<CoreRatePlan> {
    const property = await this.resolveProperty(dto.propertyId, user);
    const amounts = await this.checkAmounts(property, dto.amounts);

    if (dto.endDate < dto.startDate) {
      throw new BadRequestException('종료일은 시작일보다 뒤여야 합니다.');
    }
    // 요일을 모두 고르는 것은 고르지 않은 것과 같다. 빈 배열은 "매일" 로 보낸다.
    const daysOfWeek = dto.daysOfWeek?.length === 7 ? undefined : dto.daysOfWeek;
    if (daysOfWeek && new Set(daysOfWeek).size !== daysOfWeek.length) {
      throw new BadRequestException('요일이 중복되었습니다.');
    }

    return this.delegate('addRateSeason', ratePlanCode, () =>
      this.core.addRateSeason(ratePlanCode, {
        hotelId: property.operaHotelId,
        name: dto.name.trim(),
        startDate: dto.startDate,
        endDate: dto.endDate,
        daysOfWeek,
        amounts,
      }),
    );
  }

  async removeSeason(
    ratePlanCode: string,
    seasonId: string,
    propertyId: string | undefined,
    user: AuthUser,
  ): Promise<CoreRatePlan> {
    const property = await this.resolveProperty(propertyId, user);

    return this.delegate('removeRateSeason', `${ratePlanCode}/${seasonId}`, () =>
      this.core.removeRateSeason(ratePlanCode, seasonId, property.operaHotelId),
    );
  }

  // --- 패키지 ---------------------------------------------------------------

  async createPackage(dto: CreatePackageDto, user: AuthUser): Promise<CorePackage> {
    const property = await this.resolveProperty(dto.propertyId, user);

    return this.delegate('createPackage', dto.packageCode, () =>
      this.core.createPackage({
        hotelId: property.operaHotelId,
        packageCode: dto.packageCode.trim().toUpperCase(),
        name: dto.name.trim(),
        amount: dto.amount,
        calculation: dto.calculation,
        transactionCode: dto.transactionCode.trim(),
        includedInRate: dto.includedInRate,
      }),
    );
  }

  async updatePackage(
    packageCode: string,
    dto: UpdatePackageDto,
    user: AuthUser,
  ): Promise<CorePackage> {
    const property = await this.resolveProperty(dto.propertyId, user);

    return this.delegate('updatePackage', packageCode, () =>
      this.core.updatePackage(packageCode, {
        hotelId: property.operaHotelId,
        name: dto.name?.trim(),
        amount: dto.amount,
        calculation: dto.calculation,
        transactionCode: dto.transactionCode?.trim(),
        includedInRate: dto.includedInRate,
      }),
    );
  }

  // --- 공통 -----------------------------------------------------------------

  /**
   * 금액표를 우리가 아는 객실 타입으로만 받는다.
   *
   * OPERA 도 거절하지만 그쪽 메시지는 코드만 알려 준다. 어떤 코드를 쓸 수 있는지
   * 여기서 알려 주는 편이 화면에서 고치기 쉽다.
   */
  private async checkAmounts(
    property: Property,
    amounts: Record<string, unknown>,
  ): Promise<Record<string, number>> {
    const entries = Object.entries(amounts ?? {});
    if (entries.length === 0) {
      throw new BadRequestException('객실 타입별 금액이 비어 있습니다.');
    }

    const roomTypes = await this.prisma.roomType.findMany({
      where: { propertyId: property.id },
      select: { code: true },
    });
    const known = new Set(roomTypes.map((row) => row.code));

    const checked: Record<string, number> = {};
    for (const [code, raw] of entries) {
      if (!known.has(code)) {
        throw new BadRequestException(
          `알 수 없는 객실 타입입니다: ${code}. 가능한 값: ${[...known].sort().join(', ')}`,
        );
      }
      const amount = Number(raw);
      if (!Number.isFinite(amount) || !Number.isInteger(amount) || amount < 0) {
        throw new BadRequestException(`${code} 금액은 0 이상의 정수여야 합니다: ${String(raw)}`);
      }
      checked[code] = amount;
    }
    return checked;
  }

  private async resolveProperty(requested: string | undefined, user: AuthUser): Promise<Property> {
    const propertyId = resolvePropertyScope(user, requested);
    if (!propertyId) {
      throw new BadRequestException('호텔을 선택해 주세요.');
    }

    const property = await this.prisma.property.findUnique({ where: { id: propertyId } });
    if (!property) {
      throw new NotFoundException(`호텔을 찾을 수 없습니다: ${propertyId}`);
    }
    return property;
  }

  /** OPERA 로 나가는 설정 변경은 성공·실패를 모두 남긴다. 요금은 돈에 직결된다. */
  private async delegate<T>(action: string, entityId: string, call: () => Promise<T>): Promise<T> {
    const log = await this.prisma.syncLog.create({
      data: {
        entity: 'RatePlan',
        entityId,
        direction: SyncDirection.PUSH,
        status: SyncStatus.PENDING,
        payload: { action } as Prisma.InputJsonValue,
      },
    });

    try {
      const result = await call();
      await this.prisma.syncLog.update({
        where: { id: log.id },
        data: { status: SyncStatus.SUCCESS, finishedAt: new Date() },
      });
      return result;
    } catch (error) {
      await this.prisma.syncLog.update({
        where: { id: log.id },
        data: {
          status: SyncStatus.FAILED,
          finishedAt: new Date(),
          error: error instanceof Error ? error.message : String(error),
        },
      });
      throw error;
    }
  }
}
