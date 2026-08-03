import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma, SyncDirection, SyncStatus, type Profile } from '@prisma/client';
import type { AuthUser } from '../auth/auth.constants';
import { CoreClient } from '../core/core.client';
import { PrismaService } from '../prisma/prisma.service';
import { resolvePropertyScope } from '../properties/property-scope';
import { PREFERENCE_CODES, type ListProfilesDto, type UpdateProfileDto } from './dto/profiles.dto';

const VALID_PREFERENCES = new Set<string>(PREFERENCE_CODES);

/** 중복 후보를 찾은 근거. 화면이 "왜 같은 사람으로 보는가" 를 설명할 수 있어야 한다. */
export type DuplicateReason = 'SAME_EMAIL' | 'SAME_PHONE' | 'SAME_NAME' | 'SAME_MEMBERSHIP';

/**
 * 게스트 프로필.
 *
 * 프로필은 OPERA 에도 있다. 여기서 다루는 것은 **로컬 사본과 우리가 소유한
 * 부가 정보**다 — 선호 사항·내부 메모·중복 정리는 프론트의 운영 지식이고
 * OPERA 로 밀어 넣을 필드가 아니다.
 *
 * 프로필에는 호텔 범위가 없다. 같은 손님이 여러 호텔에 묵기 때문이다. 대신
 * 투숙 이력은 요청자가 볼 수 있는 호텔로 좁힌다 — 소속 직원이 다른 호텔의
 * 투숙 기록까지 보면 그 자체로 사생활 노출이다.
 */
@Injectable()
export class ProfilesService {
  private readonly logger = new Logger(ProfilesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly core: CoreClient,
  ) {}

  /** 목록은 호텔로 좁히지 않는다 — 같은 손님이 여러 호텔에 묵기 때문이다. */
  async list(query: ListProfilesDto) {
    const { q, type, tier, vip, includeMerged, limit = 50, offset = 0 } = query;

    const where: Prisma.ProfileWhereInput = {
      ...(type ? { type } : {}),
      ...(tier ? { membershipTier: tier } : {}),
      ...(vip === undefined ? {} : { vip }),
      // 병합된 프로필은 정본이 아니다. 목록에 섞이면 어느 쪽에 적을지 헷갈린다.
      ...(includeMerged ? {} : { mergedIntoId: null }),
      ...(q ? { OR: searchClauses(q) } : {}),
    };

    const [items, total] = await Promise.all([
      this.prisma.profile.findMany({
        where,
        orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
        take: limit,
        skip: offset,
      }),
      this.prisma.profile.count({ where }),
    ]);

    return { items, total, limit, offset };
  }

  async findOne(id: string, user: AuthUser) {
    const profile = await this.prisma.profile.findUnique({
      where: { id },
      include: { mergedInto: { select: { id: true, firstName: true, lastName: true } } },
    });
    if (!profile) {
      throw new NotFoundException(`프로필을 찾을 수 없습니다: ${id}`);
    }

    // 투숙 이력은 요청자가 볼 수 있는 호텔로만 좁힌다.
    const scopedPropertyId = resolvePropertyScope(user, undefined);
    const stays = await this.prisma.reservation.findMany({
      where: {
        profileId: id,
        ...(scopedPropertyId ? { propertyId: scopedPropertyId } : {}),
      },
      include: { property: { select: { name: true } }, roomType: { select: { code: true } } },
      orderBy: { arrivalDate: 'desc' },
      take: 50,
    });

    const nights = stays.reduce((sum, stay) => sum + nightsBetween(stay), 0);
    const revenue = stays.reduce(
      (sum, stay) => sum.add(stay.totalAmount ?? 0),
      new Prisma.Decimal(0),
    );

    return {
      ...profile,
      /** 병합된 프로필이면 어디로 갔는지 알려 준다. 그냥 비어 보이면 오해한다. */
      merged: Boolean(profile.mergedIntoId),
      stays,
      summary: {
        stayCount: stays.length,
        nights,
        revenue: revenue.toFixed(2),
        lastStay: stays[0] ? stays[0].arrivalDate : null,
      },
    };
  }

  async update(id: string, dto: UpdateProfileDto): Promise<Profile> {
    const profile = await this.load(id);

    // 병합된 프로필을 고치면 정본과 갈린다. 어느 쪽이 맞는지 알 수 없게 된다.
    if (profile.mergedIntoId) {
      throw new BadRequestException(
        '이미 다른 프로필로 병합된 프로필입니다. 정본 프로필에서 수정해 주세요.',
      );
    }

    if (dto.preferences) {
      const unknown = dto.preferences.filter((code) => !VALID_PREFERENCES.has(code));
      if (unknown.length > 0) {
        throw new BadRequestException(`알 수 없는 선호 코드입니다: ${unknown.join(', ')}`);
      }
    }

    return this.prisma.profile.update({
      where: { id },
      data: {
        ...(dto.firstName === undefined ? {} : { firstName: dto.firstName.trim() || null }),
        ...(dto.lastName === undefined ? {} : { lastName: dto.lastName.trim() || null }),
        ...(dto.companyName === undefined ? {} : { companyName: dto.companyName.trim() || null }),
        ...(dto.email === undefined ? {} : { email: dto.email.trim().toLowerCase() || null }),
        ...(dto.phone === undefined ? {} : { phone: normalizePhone(dto.phone) }),
        ...(dto.nationality === undefined
          ? {}
          : { nationality: dto.nationality.toUpperCase() || null }),
        ...(dto.vip === undefined ? {} : { vip: dto.vip }),
        ...(dto.membershipNumber === undefined
          ? {}
          : { membershipNumber: dto.membershipNumber.trim() || null }),
        ...(dto.membershipTier === undefined ? {} : { membershipTier: dto.membershipTier }),
        // 중복은 걷어낸다. 같은 선호가 두 번 들어가면 배정 화면이 지저분해진다.
        ...(dto.preferences === undefined ? {} : { preferences: [...new Set(dto.preferences)] }),
        ...(dto.notes === undefined ? {} : { notes: dto.notes.trim() || null }),
      },
    });
  }

  /**
   * 중복 후보.
   *
   * 자동으로 합치지 않는다. 이름이 같은 다른 사람은 흔하고, 잘못 합치면 남의
   * 투숙 이력과 선호가 섞인다. 근거를 붙여 보여 주고 판단은 사람이 한다.
   */
  async duplicates(id: string) {
    const profile = await this.load(id);

    const clauses: Prisma.ProfileWhereInput[] = [];
    if (profile.email) clauses.push({ email: { equals: profile.email, mode: 'insensitive' } });
    if (profile.phone) clauses.push({ phone: profile.phone });
    if (profile.membershipNumber) {
      clauses.push({ membershipNumber: profile.membershipNumber });
    }
    if (profile.lastName && profile.firstName) {
      clauses.push({
        lastName: { equals: profile.lastName, mode: 'insensitive' },
        firstName: { equals: profile.firstName, mode: 'insensitive' },
      });
    }

    if (clauses.length === 0) {
      return { profileId: id, items: [] };
    }

    const candidates = await this.prisma.profile.findMany({
      where: { id: { not: id }, mergedIntoId: null, OR: clauses },
      take: 20,
      orderBy: { updatedAt: 'desc' },
    });

    return {
      profileId: id,
      items: candidates.map((candidate) => ({
        profile: candidate,
        reasons: reasonsFor(profile, candidate),
      })),
    };
  }

  /**
   * 병합.
   *
   * 원본을 지우지 않는다. 과거 예약이 참조하고 있어 삭제하면 예약의 게스트가
   * 사라진다. 예약을 정본으로 옮기고 원본에는 어디로 합쳐졌는지만 남긴다.
   */
  async merge(sourceId: string, targetId: string) {
    if (sourceId === targetId) {
      throw new BadRequestException('같은 프로필끼리는 병합할 수 없습니다.');
    }

    const [source, target] = await Promise.all([this.load(sourceId), this.load(targetId)]);

    if (source.mergedIntoId) {
      throw new BadRequestException('이미 병합된 프로필입니다.');
    }
    if (target.mergedIntoId) {
      throw new BadRequestException(
        '대상 프로필이 이미 다른 프로필로 병합되었습니다. 정본을 대상으로 지정해 주세요.',
      );
    }

    /*
     * 양쪽 다 OPERA 프로필이면 OPERA 에서 먼저 합친다.
     *
     * 로컬만 합쳐도 OPERA 에는 여전히 둘이고, 다음 동기화가 지운 쪽을 되살린다.
     * OPERA 가 거절하면 로컬도 건드리지 않는다 — 한쪽만 합쳐진 상태가 가장 나쁘다.
     */
    if (source.operaProfileId && target.operaProfileId) {
      const log = await this.startLog(source.operaProfileId, {
        action: 'merge',
        targetProfileId: target.operaProfileId,
      });

      try {
        await this.core.mergeProfile(source.operaProfileId, target.operaProfileId);
        await this.finishLog(log.id, SyncStatus.SUCCESS, target.operaProfileId);
      } catch (error) {
        await this.finishLog(log.id, SyncStatus.FAILED, source.operaProfileId, error);
        throw error;
      }
    }

    return this.prisma.$transaction(async (tx) => {
      await tx.reservation.updateMany({
        where: { profileId: sourceId },
        data: { profileId: targetId },
      });

      // 비어 있는 칸만 채운다. 정본의 값을 덮어쓰면 사람이 고른 쪽이 사라진다.
      const merged = await tx.profile.update({
        where: { id: targetId },
        data: {
          firstName: target.firstName ?? source.firstName,
          lastName: target.lastName ?? source.lastName,
          companyName: target.companyName ?? source.companyName,
          email: target.email ?? source.email,
          phone: target.phone ?? source.phone,
          nationality: target.nationality ?? source.nationality,
          membershipNumber: target.membershipNumber ?? source.membershipNumber,
          operaProfileId: target.operaProfileId ?? source.operaProfileId,
          // VIP 는 한쪽이라도 VIP 면 VIP 다. 낮춰 잡으면 응대가 빠진다.
          vip: target.vip || source.vip,
          preferences: [...new Set([...target.preferences, ...source.preferences])],
          notes: joinNotes(target.notes, source.notes),
        },
      });

      /*
       * operaProfileId 는 고유 제약이 있다.
       *
       * 정본에 없어서 옮겨 왔으면 원본에서 떼어 내야 다음 저장이 터지지 않는다.
       * 양쪽 다 있었으면 OPERA 가 합쳤으므로 원본 ID 는 더 이상 유효하지 않다.
       */
      await tx.profile.update({
        where: { id: sourceId },
        data: { mergedIntoId: targetId, operaProfileId: null },
      });

      return merged;
    });
  }

  /** 쓰기는 이력을 남긴다. OPERA 호출이 실패했을 때 무엇을 보냈는지 알아야 한다. */
  private startLog(entityId: string | null, payload: unknown) {
    return this.prisma.syncLog.create({
      data: {
        entity: 'Profile',
        entityId,
        direction: SyncDirection.PUSH,
        status: SyncStatus.PENDING,
        payload: payload as Prisma.InputJsonValue,
      },
    });
  }

  private async finishLog(
    id: string,
    status: SyncStatus,
    entityId: string | null,
    error?: unknown,
  ): Promise<void> {
    const message = error instanceof Error ? error.message : error ? String(error) : null;
    if (message) {
      this.logger.warn(`OPERA 프로필 병합 실패: ${message}`);
    }

    await this.prisma.syncLog.update({
      where: { id },
      data: {
        status,
        finishedAt: new Date(),
        ...(entityId ? { entityId } : {}),
        ...(message ? { error: message } : {}),
      },
    });
  }

  private async load(id: string): Promise<Profile> {
    const profile = await this.prisma.profile.findUnique({ where: { id } });
    if (!profile) {
      throw new NotFoundException(`프로필을 찾을 수 없습니다: ${id}`);
    }
    return profile;
  }
}

function searchClauses(q: string): Prisma.ProfileWhereInput[] {
  const term = q.trim();
  const insensitive = Prisma.QueryMode.insensitive;

  return [
    { lastName: { contains: term, mode: insensitive } },
    { firstName: { contains: term, mode: insensitive } },
    { companyName: { contains: term, mode: insensitive } },
    { email: { contains: term, mode: insensitive } },
    // 전화는 하이픈·공백이 제각각이라 숫자만 남겨 비교한다.
    { phone: { contains: normalizePhone(term) ?? term } },
    { membershipNumber: { contains: term, mode: insensitive } },
  ];
}

function reasonsFor(a: Profile, b: Profile): DuplicateReason[] {
  const reasons: DuplicateReason[] = [];
  if (a.email && b.email && a.email.toLowerCase() === b.email.toLowerCase()) {
    reasons.push('SAME_EMAIL');
  }
  if (a.phone && b.phone && a.phone === b.phone) reasons.push('SAME_PHONE');
  if (a.membershipNumber && a.membershipNumber === b.membershipNumber) {
    reasons.push('SAME_MEMBERSHIP');
  }
  if (
    a.lastName &&
    b.lastName &&
    a.firstName &&
    b.firstName &&
    a.lastName.toLowerCase() === b.lastName.toLowerCase() &&
    a.firstName.toLowerCase() === b.firstName.toLowerCase()
  ) {
    reasons.push('SAME_NAME');
  }
  return reasons;
}

/** 숫자만 남긴다. `010-1234-5678` 과 `01012345678` 이 다른 사람이 되면 안 된다. */
function normalizePhone(phone: string): string | null {
  const digits = phone.replace(/\D/g, '');
  return digits || null;
}

function joinNotes(target: string | null, source: string | null): string | null {
  if (!source) return target;
  if (!target) return source;
  return `${target}\n---\n${source}`;
}

function nightsBetween(stay: { arrivalDate: Date; departureDate: Date }): number {
  return Math.max(
    0,
    Math.round((stay.departureDate.getTime() - stay.arrivalDate.getTime()) / 86_400_000),
  );
}
