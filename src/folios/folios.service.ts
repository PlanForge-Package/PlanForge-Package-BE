import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { AuthUser } from '../auth/auth.constants';
import { CoreClient } from '../core/core.client';

import { PrismaService } from '../prisma/prisma.service';
import { assertWithinScope } from '../properties/property-scope';
import type {
  CreatePostingDto,
  OpenFolioDto,
  RecordDepositDto,
  SetRoutingDto,
  TransferPostingDto,
} from './dto/folios.dto';
import { mirrorFolios, toOperaPostingType } from './folio-mirror';
import { withSyncLog } from '../sync/sync-log';

/**
 * Folio — the guest's bill.
 *
 * The ledger's source is OPERA. Opening windows and posting transactions are all
 * delegated to OPERA through Core, and the result is copied locally. The balance
 * is theirs as well — two systems counting separately eventually disagree, and in
 * accounting data there is no way to tell which side is right.
 *
 * Only conditions we know better are checked locally. OPERA does not know whether
 * a posting came from a payment or which POS outlet raised it.
 */
@Injectable()
export class FoliosService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly core: CoreClient,
  ) {}

  async listByReservation(reservationId: string, user: AuthUser) {
    await this.load(reservationId, user);

    return this.prisma.folio.findMany({
      where: { reservationId },
      include: { postings: { orderBy: { postedAt: 'asc' } } },
      orderBy: { window: 'asc' },
    });
  }

  /** Opens an extra folio window for a split settlement. */
  async openWindow(reservationId: string, dto: OpenFolioDto, user: AuthUser) {
    const { reservation, operaId } = await this.load(reservationId, user);

    const folio = await this.delegate(
      reservationId,
      { action: 'openFolio', window: dto.window },
      () =>
        this.core.openFolio(operaId, {
          hotelId: reservation.property.operaHotelId,
          ...(dto.window === undefined ? {} : { window: dto.window }),
        }),
    );

    await this.prisma.$transaction((tx) =>
      mirrorFolios(tx, reservationId, reservation.currency, [folio]),
    );

    return this.prisma.folio.findUnique({
      where: { reservationId_window: { reservationId, window: folio.window } },
      include: { postings: { orderBy: { postedAt: 'asc' } } },
    });
  }

  /**
   * Takes a deposit.
   *
   * There is no charge yet before arrival, but the money is already ours. Without
   * posting it as a payment, the guest pays twice at check-in or is never refunded.
   *
   * The same check number coming again is blocked by OPERA — taking a deposit twice
   * takes the guest's money twice.
   *
   * Card authorisation does not use this path yet. Once a PSP is chosen it has to
   * go through the same driver as folio payments.
   */
  async recordDeposit(reservationId: string, dto: RecordDepositDto, user: AuthUser) {
    const { reservation, operaId } = await this.load(reservationId, user);

    const folio = await this.delegate(
      reservationId,
      { action: 'recordDeposit', amount: dto.amount, method: dto.method },
      () =>
        this.core.recordDeposit(operaId, {
          hotelId: reservation.property.operaHotelId,
          amount: dto.amount,
          description: dto.description?.trim() || `보증금 (${dto.method})`,
          ...(dto.reference ? { reference: dto.reference } : {}),
        }),
    );

    await this.prisma.$transaction((tx) =>
      mirrorFolios(tx, reservationId, reservation.currency, [folio]),
    );

    return this.prisma.folio.findUnique({
      where: { reservationId_window: { reservationId, window: folio.window } },
      include: { postings: { orderBy: { postedAt: 'asc' } } },
    });
  }

  /** Posts a transaction. The balance is refreshed from OPERA's confirmed value. */
  async addPosting(reservationId: string, window: number, dto: CreatePostingDto, user: AuthUser) {
    const { reservation, operaId } = await this.load(reservationId, user);

    const folio = await this.delegate(
      reservationId,
      { action: 'addPosting', window, type: dto.type, amount: dto.amount },
      () =>
        this.core.createPosting(operaId, window, {
          hotelId: reservation.property.operaHotelId,
          type: toOperaPostingType(dto.type),
          transactionCode: dto.transactionCode,
          description: dto.description,
          amount: dto.amount,
          ...(dto.negative ? { negative: true } : {}),
        }),
    );

    await this.prisma.$transaction((tx) =>
      mirrorFolios(tx, reservationId, reservation.currency, [folio]),
    );

    return this.prisma.folio.findUnique({
      where: { reservationId_window: { reservationId, window } },
      include: { postings: { orderBy: { postedAt: 'asc' } } },
    });
  }

  /**
   * Moves a transaction to another window.
   *
   * "The company pays the room" is often settled late in the stay. Deleting and
   * re-posting a charge counts as two accounting incidents, so the original is
   * moved as is and where it came from is recorded.
   */
  async transferPosting(
    reservationId: string,
    postingId: string,
    dto: TransferPostingDto,
    user: AuthUser,
  ) {
    const { reservation, operaId } = await this.load(reservationId, user);

    const posting = await this.prisma.posting.findUnique({
      where: { id: postingId },
      include: { folio: true },
    });
    if (!posting || posting.folio.reservationId !== reservationId) {
      throw new NotFoundException(`거래를 찾을 수 없습니다: ${postingId}`);
    }

    /*
     * Postings created by a payment are not moved.
     *
     * The Payment record points at a folio, so moving only the posting leaves the
     * payment here and its trace there. A refund or void would not know which folio
     * to reverse. OPERA does not know this relation, so it is blocked here.
     */
    if (posting.paymentId) {
      throw new BadRequestException(
        '결제로 생긴 거래는 옮길 수 없습니다. 결제를 취소한 뒤 다시 받아 주세요.',
      );
    }

    if (!posting.operaPostingId) {
      throw new BadRequestException(
        'OPERA 와 연결되지 않은 거래입니다. 먼저 동기화한 뒤 다시 시도해 주세요.',
      );
    }

    const result = await this.delegate(
      reservationId,
      { action: 'transferPosting', postingId: posting.operaPostingId, toWindow: dto.toWindow },
      () =>
        this.core.transferPosting(operaId, posting.operaPostingId!, {
          hotelId: reservation.property.operaHotelId,
          toWindow: dto.toWindow,
        }),
    );

    await this.prisma.$transaction((tx) =>
      mirrorFolios(tx, reservationId, reservation.currency, result.folios),
    );

    return this.prisma.folio.findMany({
      where: { reservationId },
      include: { postings: { orderBy: { postedAt: 'asc' } } },
      orderBy: { window: 'asc' },
    });
  }

  /** Routing instructions for a reservation. Ours to arrange, so not sent to OPERA. */
  async listRoutings(reservationId: string, user: AuthUser) {
    await this.load(reservationId, user);

    const items = await this.prisma.folioRouting.findMany({
      where: { reservationId },
      orderBy: { transactionCode: 'asc' },
    });
    return { items, total: items.length };
  }

  /**
   * Sets or changes a routing instruction.
   *
   * Two instructions on one transaction code leave no way to know which wins, so
   * there is only ever one. Setting it again changes the destination.
   */
  async setRouting(reservationId: string, dto: SetRoutingDto, user: AuthUser) {
    await this.load(reservationId, user);

    // Sending to a missing window fails on every charge. Blocked now.
    const target = await this.prisma.folio.findUnique({
      where: { reservationId_window: { reservationId, window: dto.targetWindow } },
    });
    if (!target) {
      throw new NotFoundException(
        `윈도 ${dto.targetWindow} 이 열려 있지 않습니다. 먼저 창구를 열어 주세요.`,
      );
    }

    const code = dto.transactionCode.trim();
    return this.prisma.folioRouting.upsert({
      where: { reservationId_transactionCode: { reservationId, transactionCode: code } },
      update: { targetWindow: dto.targetWindow, note: dto.note ?? null, createdById: user.id },
      create: {
        reservationId,
        transactionCode: code,
        targetWindow: dto.targetWindow,
        note: dto.note ?? null,
        createdById: user.id,
      },
    });
  }

  async removeRouting(reservationId: string, transactionCode: string, user: AuthUser) {
    await this.load(reservationId, user);

    const existing = await this.prisma.folioRouting.findUnique({
      where: { reservationId_transactionCode: { reservationId, transactionCode } },
    });
    if (!existing) {
      throw new NotFoundException(`라우팅 지시를 찾을 수 없습니다: ${transactionCode}`);
    }

    await this.prisma.folioRouting.delete({ where: { id: existing.id } });
    return { removed: true, transactionCode };
  }

  /**
   * A folio hangs off a reservation, so access is judged by the reservation's hotel.
   * The path is reachable from a reservation id alone, so it is always checked here.
   */
  private async load(reservationId: string, user: AuthUser) {
    const reservation = await this.prisma.reservation.findUnique({
      where: { id: reservationId },
      include: { property: true },
    });
    if (!reservation) {
      throw new NotFoundException(`예약을 찾을 수 없습니다: ${reservationId}`);
    }
    assertWithinScope(user, reservation.propertyId);

    if (!reservation.operaReservationId) {
      throw new BadRequestException(
        'OPERA 와 연결되지 않은 예약입니다. 먼저 동기화한 뒤 다시 시도해 주세요.',
      );
    }

    return { reservation, operaId: reservation.operaReservationId };
  }

  /** Wraps one delegation in a SyncLog, so a failure records what we were sending. */
  private delegate<T>(
    reservationId: string,
    payload: Record<string, unknown>,
    call: () => Promise<T>,
  ): Promise<T> {
    return withSyncLog(this.prisma, { entity: 'Folio', entityId: reservationId, payload }, call);
  }
}
