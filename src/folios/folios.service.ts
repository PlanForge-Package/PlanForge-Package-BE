import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { FolioStatus, PostingType, Prisma } from '@prisma/client';
import type { AuthUser } from '../auth/auth.constants';
import { PrismaService } from '../prisma/prisma.service';
import { assertWithinScope } from '../properties/property-scope';
import type {
  CreatePostingDto,
  OpenFolioDto,
  SetRoutingDto,
  TransferPostingDto,
} from './dto/folios.dto';

/** OPERA 는 예약당 폴리오 윈도를 8개까지 둔다. */
const MAX_WINDOW = 8;

/**
 * 거래 종류별 잔액 방향.
 *
 * 저장되는 `amount` 는 부호가 붙은 값이고, 잔액은 항상 거래 합계로 다시 계산한다.
 * 증분으로 더해 가면 한 번의 실패가 영구적인 잔액 오차로 남기 때문이다.
 */
function signedAmount(dto: CreatePostingDto): Prisma.Decimal {
  const magnitude = new Prisma.Decimal(dto.amount);

  switch (dto.type) {
    case PostingType.CHARGE:
    case PostingType.TAX:
      return magnitude;
    case PostingType.PAYMENT:
      return magnitude.negated();
    case PostingType.ADJUSTMENT:
      return dto.negative ? magnitude.negated() : magnitude;
  }
}

@Injectable()
export class FoliosService {
  constructor(private readonly prisma: PrismaService) {}

  async listByReservation(reservationId: string, user: AuthUser) {
    await this.assertReservationInScope(reservationId, user);

    return this.prisma.folio.findMany({
      where: { reservationId },
      include: { postings: { orderBy: { postedAt: 'asc' } } },
      orderBy: { window: 'asc' },
    });
  }

  /** 분할 정산을 위해 폴리오 윈도를 추가로 연다. */
  async openWindow(reservationId: string, dto: OpenFolioDto, user: AuthUser) {
    return this.prisma.$transaction(async (tx) => {
      const reservation = await tx.reservation.findUnique({
        where: { id: reservationId },
        select: { id: true, currency: true, propertyId: true },
      });
      if (!reservation) {
        throw new NotFoundException(`예약을 찾을 수 없습니다: ${reservationId}`);
      }
      assertWithinScope(user, reservation.propertyId);

      const existing = await tx.folio.findMany({
        where: { reservationId },
        select: { window: true },
      });
      const used = new Set(existing.map((folio) => folio.window));

      let window = dto.window;
      if (window === undefined) {
        window = 1;
        while (used.has(window) && window <= MAX_WINDOW) window += 1;
      }

      if (window > MAX_WINDOW) {
        throw new BadRequestException(`폴리오 윈도는 ${MAX_WINDOW}개까지만 열 수 있습니다.`);
      }
      if (used.has(window)) {
        throw new BadRequestException(`윈도 ${window} 은 이미 열려 있습니다.`);
      }

      return tx.folio.create({
        data: { reservationId, window, currency: reservation.currency },
      });
    });
  }

  /**
   * 거래를 등록하고 잔액을 다시 계산한다.
   *
   * 마감된 폴리오에는 등록할 수 없다 — 마감 후 거래가 붙으면 체크아웃 시점의
   * 잔액 0 검증이 무의미해진다.
   */
  async addPosting(reservationId: string, window: number, dto: CreatePostingDto, user: AuthUser) {
    await this.assertReservationInScope(reservationId, user);

    return this.prisma.$transaction(async (tx) => {
      const folio = await tx.folio.findUnique({
        where: { reservationId_window: { reservationId, window } },
      });
      if (!folio) {
        throw new NotFoundException(
          `폴리오를 찾을 수 없습니다: 예약 ${reservationId} 윈도 ${window}`,
        );
      }
      if (folio.status === FolioStatus.CLOSED) {
        throw new BadRequestException('마감된 폴리오에는 거래를 등록할 수 없습니다.');
      }

      await tx.posting.create({
        data: {
          folioId: folio.id,
          type: dto.type,
          transactionCode: dto.transactionCode,
          description: dto.description,
          amount: signedAmount(dto),
          currency: folio.currency,
        },
      });

      const totals = await tx.posting.aggregate({
        where: { folioId: folio.id },
        _sum: { amount: true },
      });

      return tx.folio.update({
        where: { id: folio.id },
        data: { balance: totals._sum.amount ?? new Prisma.Decimal(0) },
        include: { postings: { orderBy: { postedAt: 'asc' } } },
      });
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
    await this.assertReservationInScope(reservationId, user);

    return this.prisma.$transaction(async (tx) => {
      const posting = await tx.posting.findUnique({
        where: { id: postingId },
        include: { folio: true },
      });
      if (!posting || posting.folio.reservationId !== reservationId) {
        throw new NotFoundException(`거래를 찾을 수 없습니다: ${postingId}`);
      }

      if (posting.folio.window === dto.toWindow) {
        throw new BadRequestException(`이미 윈도 ${dto.toWindow} 에 있는 거래입니다.`);
      }

      /*
       * 취소된 전표와 그 조정은 함께 있어야 한다.
       *
       * 한쪽만 옮기면 원본은 이 창구에, 반대 부호의 조정은 저 창구에 남아
       * 양쪽 잔액이 모두 틀어진다. 상계된 짝은 옮길 이유도 없다.
       */
      if (posting.voidedById) {
        throw new BadRequestException('취소된 거래는 옮길 수 없습니다.');
      }
      const isVoidAdjustment = await tx.posting.findFirst({
        where: { voidedById: posting.id },
        select: { id: true },
      });
      if (isVoidAdjustment) {
        throw new BadRequestException('취소 조정은 옮길 수 없습니다.');
      }

      /*
       * 결제가 만든 포스팅은 옮기지 않는다.
       *
       * Payment 레코드가 폴리오를 가리키고 있어, 포스팅만 옮기면 결제는 여기,
       * 그 흔적은 저기에 남는다. 환불·승인취소가 어느 폴리오를 되돌려야 할지
       * 알 수 없게 된다.
       */
      if (posting.paymentId) {
        throw new BadRequestException(
          '결제로 생긴 거래는 옮길 수 없습니다. 결제를 취소한 뒤 다시 받아 주세요.',
        );
      }

      if (posting.folio.status === FolioStatus.CLOSED) {
        throw new BadRequestException('마감된 폴리오의 거래는 옮길 수 없습니다.');
      }

      const target = await tx.folio.findUnique({
        where: { reservationId_window: { reservationId, window: dto.toWindow } },
      });
      if (!target) {
        throw new NotFoundException(
          `윈도 ${dto.toWindow} 이 열려 있지 않습니다. 먼저 창구를 열어 주세요.`,
        );
      }
      if (target.status === FolioStatus.CLOSED) {
        throw new BadRequestException(`윈도 ${dto.toWindow} 은 이미 마감되었습니다.`);
      }

      await tx.posting.update({
        where: { id: postingId },
        data: {
          folioId: target.id,
          transferredFromWindow: posting.folio.window,
          transferredAt: new Date(),
          transferredById: user.id,
        },
      });

      // 양쪽 잔액을 모두 다시 센다. 한쪽만 고치면 합계가 맞지 않는다.
      await this.recalculate(tx, posting.folioId);
      await this.recalculate(tx, target.id);

      return tx.folio.findMany({
        where: { reservationId },
        include: { postings: { orderBy: { postedAt: 'asc' } } },
        orderBy: { window: 'asc' },
      });
    });
  }

  /** 예약의 라우팅 지시. */
  async listRoutings(reservationId: string, user: AuthUser) {
    await this.assertReservationInScope(reservationId, user);

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
    await this.assertReservationInScope(reservationId, user);

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
    await this.assertReservationInScope(reservationId, user);

    const existing = await this.prisma.folioRouting.findUnique({
      where: { reservationId_transactionCode: { reservationId, transactionCode } },
    });
    if (!existing) {
      throw new NotFoundException(`라우팅 지시를 찾을 수 없습니다: ${transactionCode}`);
    }

    await this.prisma.folioRouting.delete({ where: { id: existing.id } });
    return { removed: true, transactionCode };
  }

  private async recalculate(tx: Prisma.TransactionClient, folioId: string) {
    const totals = await tx.posting.aggregate({ where: { folioId }, _sum: { amount: true } });
    return tx.folio.update({
      where: { id: folioId },
      data: { balance: totals._sum.amount ?? new Prisma.Decimal(0) },
    });
  }

  /**
   * 폴리오는 예약에 매달려 있으므로 예약의 호텔로 접근을 판단한다.
   * 예약 ID 만 알면 닿는 경로라 여기서도 반드시 확인한다.
   */
  private async assertReservationInScope(reservationId: string, user: AuthUser): Promise<void> {
    const reservation = await this.prisma.reservation.findUnique({
      where: { id: reservationId },
      select: { propertyId: true },
    });
    if (!reservation) {
      throw new NotFoundException(`예약을 찾을 수 없습니다: ${reservationId}`);
    }
    assertWithinScope(user, reservation.propertyId);
  }
}
