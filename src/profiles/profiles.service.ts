import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma, SyncStatus, type Profile } from '@prisma/client';
import type { AuthUser } from '../auth/auth.constants';
import { CoreClient } from '../core/core.client';
import { PrismaService } from '../prisma/prisma.service';
import { resolvePropertyScope } from '../properties/property-scope';
import { PREFERENCE_CODES, type ListProfilesDto, type UpdateProfileDto } from './dto/profiles.dto';
import { finishSyncLog, startSyncLog } from '../sync/sync-log';

const VALID_PREFERENCES = new Set<string>(PREFERENCE_CODES);

/** Why a duplicate was flagged. The screen must be able to explain the match. */
export type DuplicateReason = 'SAME_EMAIL' | 'SAME_PHONE' | 'SAME_NAME' | 'SAME_MEMBERSHIP';

/**
 * Guest profiles.
 *
 * Profiles exist in OPERA too. What is handled here is the **local copy and the
 * extra information we own** — preferences, internal notes and duplicate cleanup
 * are front-desk operational knowledge, not fields to push into OPERA.
 *
 * Profiles have no hotel scope, because one guest stays at several hotels. Stay
 * history is narrowed to the hotels the requester may see — staff of one hotel
 * reading another's stay records is a privacy exposure in itself.
 */
@Injectable()
export class ProfilesService {
  private readonly logger = new Logger(ProfilesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly core: CoreClient,
  ) {}

  /** The list is not narrowed by hotel — one guest stays at several hotels. */
  async list(query: ListProfilesDto) {
    const { q, type, tier, vip, includeMerged, limit = 50, offset = 0 } = query;

    const where: Prisma.ProfileWhereInput = {
      ...(type ? { type } : {}),
      ...(tier ? { membershipTier: tier } : {}),
      ...(vip === undefined ? {} : { vip }),
      // Merged profiles are not canonical. Mixed in, it is unclear which to write to.
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

    // Stay history is narrowed to the hotels the requester may see.
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
      /** Where a merged profile went. Appearing simply empty would be misleading. */
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

    // Editing a merged profile splits it from the canonical one, with no way to tell which is right.
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
        // Duplicates are stripped. The same preference twice clutters the assignment screen.
        ...(dto.preferences === undefined ? {} : { preferences: [...new Set(dto.preferences)] }),
        ...(dto.notes === undefined ? {} : { notes: dto.notes.trim() || null }),
      },
    });
  }

  /**
   * Duplicate candidates.
   *
   * Nothing is merged automatically. Different people share names often, and a bad
   * merge mixes stay history and preferences. Evidence is shown; a person decides.
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
   * Merge.
   *
   * The source is not deleted. Past reservations reference it and would lose their
   * guest. Reservations move to the canonical profile; the source records where it went.
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
     * When both have OPERA profiles, OPERA merges first.
     *
     * Merged locally only, OPERA still has two and the next sync revives the one we
     * removed. If OPERA refuses, nothing local changes — a half-merge is the worst state.
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

      // Only empty fields are filled. Overwriting the canonical value loses the chosen one.
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
          // VIP wins if either side is VIP. Downgrading drops the service that goes with it.
          vip: target.vip || source.vip,
          preferences: [...new Set([...target.preferences, ...source.preferences])],
          notes: joinNotes(target.notes, source.notes),
        },
      });

      /*
       * operaProfileId has a unique constraint.
       *
       * Moved over because the canonical lacked one, it must be detached from the
       * source. If both had one, OPERA merged them and the source id is no longer valid.
       */
      await tx.profile.update({
        where: { id: sourceId },
        data: { mergedIntoId: targetId, operaProfileId: null },
      });

      return merged;
    });
  }

  /** Writes are logged. A failed OPERA call needs to show what we sent. */
  private startLog(entityId: string | null, payload: unknown) {
    return startSyncLog(this.prisma, 'Profile', entityId, payload);
  }

  private finishLog(
    id: string,
    status: SyncStatus,
    entityId: string | null,
    error?: unknown,
  ): Promise<void> {
    return finishSyncLog(this.prisma, id, status, {
      entityId,
      error,
      warn: (message) => this.logger.warn(`OPERA 프로필 병합 실패: ${message}`),
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
    // Phone numbers vary in hyphens and spaces, so only digits are compared.
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

/** Digits only. `010-1234-5678` and `01012345678` must not be different people. */
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
