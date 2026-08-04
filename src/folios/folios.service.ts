import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, SyncDirection, SyncStatus } from '@prisma/client';
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

/**
 * 폴리오 — 손님의 계산서.
 *
 * 회계 원장은 OPERA 가 원천이다. 창구를 열고 거래를 다는 일은 모두 Core 를 통해
 * OPERA 에 맡기고, 돌아온 결과를 로컬에 옮겨 적는다. 잔액도 저쪽이 계산한 값을
 * 그대로 쓴다 — 두 시스템이 각자 세면 언젠가 갈리고, 회계 데이터에서 그건 어느
 * 쪽이 맞는지 판단할 근거가 없다는 뜻이다.
 *
 * 로컬에서 먼저 막는 것은 우리가 더 잘 아는 조건뿐이다. 결제가 만든 거래인지,
 * 어느 POS 아웃렛이 달았는지는 OPERA 가 모른다.
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

  /** 분할 정산을 위해 폴리오 윈도를 추가로 연다. */
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
   * 보증금을 받는다.
   *
   * 도착 전이라 청구는 없지만 그 돈은 이미 우리에게 있다. 폴리오에 결제로 올려
   * 두지 않으면 체크인 때 손님이 두 번 내거나, 남은 돈을 돌려주지 못한다.
   *
   * 같은 전표 번호로 다시 들어오면 OPERA 가 막는다 — 보증금을 두 번 받으면 손님
   * 돈이 두 번 나간다.
   *
   * 카드 승인은 아직 이 경로를 타지 않는다. PG 사가 정해지면 폴리오 결제와 같은
   * 드라이버를 거치도록 맞춰야 한다.
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

  /** 거래를 등록한다. 잔액은 OPERA 가 확정한 값으로 갱신된다. */
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
   * 거래를 다른 창구로 옮긴다.
   *
   * 투숙 중에 "객실료는 회사가 낸다" 가 뒤늦게 정해지는 일이 흔하다. 이미 붙은
   * 요금을 지웠다가 다시 다는 것은 회계상 두 번의 사고가 되므로, 원본을 그대로
   * 옮기고 어디서 왔는지를 남긴다.
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
     * 결제가 만든 포스팅은 옮기지 않는다.
     *
     * Payment 레코드가 폴리오를 가리키고 있어, 포스팅만 옮기면 결제는 여기,
     * 그 흔적은 저기에 남는다. 환불·승인취소가 어느 폴리오를 되돌려야 할지
     * 알 수 없게 된다. OPERA 는 이 관계를 모르므로 여기서 막는다.
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

  /** 예약의 라우팅 지시. 이 지시는 우리 편성이므로 OPERA 에 보내지 않는다. */
  async listRoutings(reservationId: string, user: AuthUser) {
    await this.load(reservationId, user);

    const items = await this.prisma.folioRouting.findMany({
      where: { reservationId },
      orderBy: { transactionCode: 'asc' },
    });
    return { items, total: items.length };
  }

  /**
   * 라우팅 지시를 걸거나 바꾼다.
   *
   * 같은 거래 코드에 두 개를 두면 어느 쪽이 이기는지 알 수 없으므로 하나만
   * 둔다. 다시 걸면 목적지가 바뀐다.
   */
  async setRouting(reservationId: string, dto: SetRoutingDto, user: AuthUser) {
    await this.load(reservationId, user);

    // 없는 창구로 보내면 요금이 붙을 때마다 실패한다. 지금 막는다.
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
   * 폴리오는 예약에 매달려 있으므로 예약의 호텔로 접근을 판단한다.
   * 예약 ID 만 알면 닿는 경로라 여기서도 반드시 확인한다.
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

  /** 위임 한 번을 SyncLog 로 감싼다. 실패하면 무엇을 보내다 실패했는지 남는다. */
  private async delegate<T>(
    reservationId: string,
    payload: Record<string, unknown>,
    call: () => Promise<T>,
  ): Promise<T> {
    const log = await this.prisma.syncLog.create({
      data: {
        entity: 'Folio',
        entityId: reservationId,
        direction: SyncDirection.PUSH,
        status: SyncStatus.PENDING,
        payload: payload as Prisma.InputJsonValue,
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
