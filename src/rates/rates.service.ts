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
 * Rate codes, seasons and packages.
 *
 * OPERA sets rates — the result of seasons, weekdays, promotions and revenue
 * management, so computing our own would diverge from what is actually charged.
 * There is no local copy; their setup is read every time.
 *
 * The setup rarely changes, but when it is wrong every reservation is priced wrong.
 * So "what OPERA holds right now" matters more than the speed a cache would buy.
 */
@Injectable()
export class RatesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly core: CoreClient,
  ) {}

  // --- Reads ------------------------------------------------------------------

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

  // --- Rate codes --------------------------------------------------------------

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

  // --- Seasons ------------------------------------------------------------------

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
    // Picking every weekday is the same as picking none. An empty array means daily.
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

  // --- Packages -----------------------------------------------------------------

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

  // --- Shared -------------------------------------------------------------------

  /**
   * Amount tables are accepted only for room types we know.
   *
   * OPERA rejects them too, but its message only names the code. Saying which codes
   * are valid here makes it easier to fix on the screen.
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

  /** Setup changes going to OPERA log both success and failure. Rates are money. */
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
