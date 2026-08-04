import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { FolioStatus, Prisma, ReservationStatus, type PosOutlet } from '@prisma/client';
import { CoreClient } from '../core/core.client';
import type { CoreFolio } from '../core/core.types';
import { mirrorFolios } from '../folios/folio-mirror';
import { PrismaService } from '../prisma/prisma.service';
import type { PostRoomChargeDto, VoidRoomChargeDto } from './dto/pos.dto';

/**
 * 외부 POS 의 룸차지.
 *
 * 아웃렛이 할 수 있는 일은 두 가지뿐이다 — 재실 객실에 요금을 달고, 자기가 단
 * 요금을 취소하는 것. 예약을 읽거나 손님 정보를 가져가지 못한다. 단말은 매장에
 * 놓여 있고 물리적으로 안전하지 않다고 보아야 한다.
 *
 * 요금은 OPERA 의 폴리오에 달린다. 로컬에만 적으면 OPERA 의 계산서와 우리
 * 잔액이 갈리고, 손님은 두 장의 다른 명세서를 받는다.
 */
@Injectable()
export class PosService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly core: CoreClient,
  ) {}

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
    // 재전송을 여기서 먼저 끊는다. OPERA 도 같은 전표를 두 번 달지 않지만,
    // 확실히 아는 재시도까지 외부 호출을 태울 이유가 없다.
    const existing = await this.prisma.posting.findUnique({
      where: { outletId_reference: { outletId: outlet.id, reference: dto.reference } },
      include: { folio: { select: { reservationId: true, window: true, balance: true } } },
    });
    if (existing) {
      return { duplicate: true, ...this.toReceipt(existing, existing.folio) };
    }

    const transactionCode = dto.transactionCode ?? outlet.transactionCode;

    const reservation = await this.prisma.reservation.findFirst({
      where: {
        propertyId: outlet.propertyId,
        assignedRoomNumber: dto.roomNumber,
        status: ReservationStatus.IN_HOUSE,
      },
      select: { id: true, currency: true, operaReservationId: true, property: true },
    });
    if (!reservation) {
      // 빈 객실에 요금을 달면 아무도 받지 않는 청구가 생긴다.
      throw new NotFoundException(
        `재실 중인 예약이 없습니다: ${dto.roomNumber}호. 객실 번호를 확인해 주세요.`,
      );
    }
    if (!reservation.operaReservationId) {
      throw new BadRequestException(
        `OPERA 와 연결되지 않은 예약입니다: ${dto.roomNumber}호. 프런트에 문의해 주세요.`,
      );
    }

    /*
     * 창구는 라우팅 지시가 정한다.
     *
     * POS 단말은 이 예약의 정산 편성을 모른다. 회사가 객실료를, 손님이
     * 부대비용을 내는 편성에서 단말이 보낸 창구를 그대로 믿으면 요금이
     * 엉뚱한 쪽에 붙는다. 단말이 창구를 지정했으면 그건 존중한다 —
     * 아무 지시도 없을 때만 1번으로 간다.
     */
    const routing = dto.window
      ? null
      : await this.prisma.folioRouting.findUnique({
          where: {
            reservationId_transactionCode: { reservationId: reservation.id, transactionCode },
          },
          select: { targetWindow: true },
        });
    const window = dto.window ?? routing?.targetWindow ?? 1;

    let folio: CoreFolio;
    try {
      folio = await this.core.createPosting(reservation.operaReservationId, window, {
        hotelId: reservation.property.operaHotelId,
        type: 'Charge',
        transactionCode,
        description: `[${outlet.name}] ${dto.description}`,
        amount: dto.amount,
        reference: dto.reference,
      });
    } catch (error) {
      throw this.describeFolioFailure(error, dto.roomNumber);
    }

    return this.prisma.$transaction(async (tx) => {
      await mirrorFolios(tx, reservation.id, reservation.currency, [folio]);

      const posting = await tx.posting.findFirst({
        where: { folio: { reservationId: reservation.id, window }, reference: dto.reference },
      });
      if (!posting) {
        // OPERA 가 받아 줬는데 사본에 없으면 매핑이 어긋난 것이다. 조용히 넘기면
        // 취소도 대사도 할 수 없는 요금이 남는다.
        throw new BadRequestException('요금을 달았으나 내역을 확인하지 못했습니다.');
      }

      // 어느 매장이 달았는지는 OPERA 가 모른다. 사본에만 남는다.
      if (posting.outletId !== outlet.id) {
        try {
          await tx.posting.update({ where: { id: posting.id }, data: { outletId: outlet.id } });
        } catch (error) {
          // 같은 전표가 동시에 두 번 들어온 경우. 고유 제약이 막아 준다.
          if (isUniqueViolation(error)) {
            throw new ConflictException(`이미 처리된 전표입니다: ${dto.reference}`);
          }
          throw error;
        }
      }

      return {
        duplicate: false,
        ...this.toReceipt(posting, {
          reservationId: reservation.id,
          window,
          balance: new Prisma.Decimal(folio.balance),
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
    const original = await this.prisma.posting.findUnique({
      where: { outletId_reference: { outletId: outlet.id, reference: dto.reference } },
      include: { folio: { include: { reservation: { include: { property: true } } } } },
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
    if (!original.operaPostingId) {
      throw new BadRequestException('OPERA 와 연결되지 않은 거래입니다. 프런트에 문의해 주세요.');
    }

    const reservation = original.folio.reservation;
    if (!reservation.operaReservationId) {
      throw new BadRequestException('OPERA 와 연결되지 않은 예약입니다. 프런트에 문의해 주세요.');
    }

    let folio: CoreFolio;
    try {
      folio = await this.core.voidPosting(reservation.operaReservationId, original.operaPostingId, {
        hotelId: reservation.property.operaHotelId,
        ...(dto.reason ? { reason: dto.reason } : {}),
        // 취소 자체에도 전표를 붙여 둔다. 취소 요청이 재전송되면 여기서 걸린다.
        reference: `${dto.reference}-VOID`,
      });
    } catch (error) {
      throw this.describeFolioFailure(error, reservation.assignedRoomNumber ?? '');
    }

    return this.prisma.$transaction(async (tx) => {
      await mirrorFolios(tx, reservation.id, reservation.currency, [folio]);

      const reversal = await tx.posting.findFirst({
        where: { folioId: original.folioId, reference: `${dto.reference}-VOID` },
      });
      if (reversal && reversal.outletId !== outlet.id) {
        await tx.posting.update({ where: { id: reversal.id }, data: { outletId: outlet.id } });
      }

      return {
        reference: dto.reference,
        voidedAmount: original.amount.toString(),
        balance: folio.balance.toString(),
      };
    });
  }

  // ---------------------------------------------------------------------------

  /**
   * OPERA 의 거절을 단말이 읽을 수 있는 말로 바꾼다.
   *
   * 매장 직원은 폴리오 윈도가 무엇인지 모른다. "프런트에 문의" 까지 알려 줘야
   * 다음 행동이 정해진다.
   */
  private describeFolioFailure(error: unknown, roomNumber: string): Error {
    const message = error instanceof Error ? error.message : String(error);
    if (/마감/.test(message)) {
      return new BadRequestException(
        `이미 마감된 폴리오입니다: ${roomNumber}호. 프런트에 문의해 주세요.`,
      );
    }
    if (/열려 있지 않/.test(message)) {
      return new NotFoundException(`폴리오를 찾을 수 없습니다: ${roomNumber}호. ${message}`);
    }
    return error instanceof Error ? error : new BadRequestException(message);
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
