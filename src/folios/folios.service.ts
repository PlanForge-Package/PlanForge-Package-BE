import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { FolioStatus, PostingType, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { CreatePostingDto, OpenFolioDto } from './dto/folios.dto';

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

  async listByReservation(reservationId: string) {
    const reservation = await this.prisma.reservation.findUnique({
      where: { id: reservationId },
      select: { id: true },
    });
    if (!reservation) {
      throw new NotFoundException(`예약을 찾을 수 없습니다: ${reservationId}`);
    }

    return this.prisma.folio.findMany({
      where: { reservationId },
      include: { postings: { orderBy: { postedAt: 'asc' } } },
      orderBy: { window: 'asc' },
    });
  }

  /** 분할 정산을 위해 폴리오 윈도를 추가로 연다. */
  async openWindow(reservationId: string, dto: OpenFolioDto) {
    return this.prisma.$transaction(async (tx) => {
      const reservation = await tx.reservation.findUnique({
        where: { id: reservationId },
        select: { id: true, currency: true },
      });
      if (!reservation) {
        throw new NotFoundException(`예약을 찾을 수 없습니다: ${reservationId}`);
      }

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
  async addPosting(reservationId: string, window: number, dto: CreatePostingDto) {
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
}
