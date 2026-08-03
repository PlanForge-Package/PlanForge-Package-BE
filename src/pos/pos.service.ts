import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  FolioStatus,
  Prisma,
  PostingType,
  ReservationStatus,
  type PosOutlet,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { PostRoomChargeDto, VoidRoomChargeDto } from './dto/pos.dto';

/**
 * 외부 POS 의 룸차지.
 *
 * 아웃렛이 할 수 있는 일은 두 가지뿐이다 — 재실 객실에 요금을 달고, 자기가 단
 * 요금을 취소하는 것. 예약을 읽거나 손님 정보를 가져가지 못한다. 단말은 매장에
 * 놓여 있고 물리적으로 안전하지 않다고 보아야 한다.
 */
@Injectable()
export class PosService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * 지금 요금을 달 수 있는 객실.
   *
   * 이름은 성만 준다. 매장 단말에 손님 명단이 통째로 뜨면 그 자체로 유출이고,
   * "1203호 김 고객님" 을 확인하는 데 그 이상은 필요 없다.
   */
  async chargeableRooms(outlet: PosOutlet) {
    const reservations = await this.prisma.reservation.findMany({
      where: {
        propertyId: outlet.propertyId,
        status: ReservationStatus.IN_HOUSE,
        assignedRoomNumber: { not: null },
      },
      select: {
        assignedRoomNumber: true,
        profile: { select: { lastName: true } },
      },
      orderBy: { assignedRoomNumber: 'asc' },
    });

    return {
      outlet: { code: outlet.code, name: outlet.name },
      items: reservations.map((r) => ({
        roomNumber: r.assignedRoomNumber,
        guestLastName: r.profile.lastName ?? '',
      })),
    };
  }

  /**
   * 룸차지.
   *
   * 같은 아웃렛의 같은 전표는 한 번만 달린다. 네트워크가 끊겨 POS 가 재전송하는
   * 일은 흔하고, 손님에게 두 번 청구되면 되돌리기 어렵다. 재전송이면 새로 달지
   * 않고 이미 단 것을 그대로 돌려준다 — POS 입장에서는 성공으로 보여야 재시도가
   * 멈춘다.
   */
  async postCharge(outlet: PosOutlet, dto: PostRoomChargeDto) {
    const existing = await this.prisma.posting.findUnique({
      where: { outletId_reference: { outletId: outlet.id, reference: dto.reference } },
      include: { folio: { select: { reservationId: true, window: true, balance: true } } },
    });
    if (existing) {
      return { duplicate: true, ...this.toReceipt(existing, existing.folio) };
    }

    const window = dto.window ?? 1;

    return this.prisma.$transaction(async (tx) => {
      const reservation = await tx.reservation.findFirst({
        where: {
          propertyId: outlet.propertyId,
          assignedRoomNumber: dto.roomNumber,
          status: ReservationStatus.IN_HOUSE,
        },
        select: { id: true, currency: true },
      });
      if (!reservation) {
        // 빈 객실에 요금을 달면 아무도 받지 않는 청구가 생긴다.
        throw new NotFoundException(
          `재실 중인 예약이 없습니다: ${dto.roomNumber}호. 객실 번호를 확인해 주세요.`,
        );
      }

      const folio = await tx.folio.findUnique({
        where: { reservationId_window: { reservationId: reservation.id, window } },
      });
      if (!folio) {
        throw new NotFoundException(
          `폴리오를 찾을 수 없습니다: ${dto.roomNumber}호 윈도 ${window}`,
        );
      }
      if (folio.status === FolioStatus.CLOSED) {
        // 마감 후 요금이 붙으면 체크아웃 시점의 잔액 0 검증이 무의미해진다.
        throw new BadRequestException(
          `이미 마감된 폴리오입니다: ${dto.roomNumber}호. 프런트에 문의해 주세요.`,
        );
      }

      let posting;
      try {
        posting = await tx.posting.create({
          data: {
            folioId: folio.id,
            type: PostingType.CHARGE,
            transactionCode: dto.transactionCode ?? outlet.transactionCode,
            description: `[${outlet.name}] ${dto.description}`,
            amount: new Prisma.Decimal(dto.amount),
            currency: folio.currency,
            outletId: outlet.id,
            reference: dto.reference,
          },
        });
      } catch (error) {
        // 같은 전표가 동시에 두 번 들어온 경우. 고유 제약이 막아 준다.
        if (isUniqueViolation(error)) {
          throw new ConflictException(`이미 처리된 전표입니다: ${dto.reference}`);
        }
        throw error;
      }

      const updated = await this.recalculate(tx, folio.id);
      return {
        duplicate: false,
        ...this.toReceipt(posting, {
          reservationId: reservation.id,
          window,
          balance: updated.balance,
        }),
      };
    });
  }

  /**
   * 룸차지 취소.
   *
   * 원본을 지우지 않고 반대 부호의 조정을 하나 더 단다. 지우면 손님 명세서에서
   * 요금이 통째로 사라져 무엇이 어떻게 정정됐는지 설명할 수 없다.
   */
  async voidCharge(outlet: PosOutlet, dto: VoidRoomChargeDto) {
    return this.prisma.$transaction(async (tx) => {
      const original = await tx.posting.findUnique({
        where: { outletId_reference: { outletId: outlet.id, reference: dto.reference } },
        include: { folio: true },
      });
      if (!original) {
        throw new NotFoundException(`전표를 찾을 수 없습니다: ${dto.reference}`);
      }
      // voidedById 가 이 포스팅을 취소한 조정을 가리킨다. 반대 방향 관계를 보면
      // "이 조정이 취소한 원본" 이 나와 언제나 비어 있다 — 방향을 거꾸로 읽기 쉽다.
      if (original.voidedById) {
        throw new ConflictException(`이미 취소된 전표입니다: ${dto.reference}`);
      }
      if (original.folio.status === FolioStatus.CLOSED) {
        throw new BadRequestException('이미 마감된 폴리오입니다. 프런트에 문의해 주세요.');
      }

      let reversal;
      try {
        reversal = await tx.posting.create({
          data: {
            folioId: original.folioId,
            type: PostingType.ADJUSTMENT,
            transactionCode: original.transactionCode,
            description: `[취소] ${original.description}${dto.reason ? ` — ${dto.reason}` : ''}`,
            amount: original.amount.negated(),
            currency: original.currency,
            outletId: outlet.id,
            // 취소 자체에도 전표를 붙여 둔다. 취소 요청이 재전송되면 여기서 걸린다.
            reference: `${dto.reference}-VOID`,
          },
        });
      } catch (error) {
        // 취소 요청이 동시에 두 번 들어온 경우. 위 검사로는 못 잡는다.
        if (isUniqueViolation(error)) {
          throw new ConflictException(`이미 취소된 전표입니다: ${dto.reference}`);
        }
        throw error;
      }

      await tx.posting.update({
        where: { id: original.id },
        data: { voidedById: reversal.id },
      });

      const updated = await this.recalculate(tx, original.folioId);
      return {
        reference: dto.reference,
        voidedAmount: original.amount.toString(),
        balance: updated.balance.toString(),
      };
    });
  }

  // ---------------------------------------------------------------------------

  /**
   * 잔액은 언제나 거래 합계로 다시 계산한다.
   *
   * 증분으로 더해 가면 한 번의 실패가 영구적인 잔액 오차로 남는다.
   */
  private async recalculate(tx: Prisma.TransactionClient, folioId: string) {
    const totals = await tx.posting.aggregate({ where: { folioId }, _sum: { amount: true } });
    return tx.folio.update({
      where: { id: folioId },
      data: { balance: totals._sum.amount ?? new Prisma.Decimal(0) },
    });
  }

  private toReceipt(
    posting: { id: string; reference: string | null; amount: Prisma.Decimal; postedAt: Date },
    folio: { reservationId: string; window: number; balance: Prisma.Decimal },
  ) {
    return {
      postingId: posting.id,
      reference: posting.reference,
      amount: posting.amount.toString(),
      postedAt: posting.postedAt,
      reservationId: folio.reservationId,
      window: folio.window,
      folioBalance: folio.balance.toString(),
    };
  }
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}
