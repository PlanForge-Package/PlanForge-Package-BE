import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { FolioStatus, PaymentMethod, PaymentStatus, Prisma, type Payment } from '@prisma/client';
import type { AuthUser } from '../auth/auth.constants';
import { CoreClient } from '../core/core.client';
import type { CoreCreatePostingInput } from '../core/core.types';
import { mirrorFolios } from '../folios/folio-mirror';
import { PrismaService } from '../prisma/prisma.service';
import { assertWithinScope } from '../properties/property-scope';
import { PAYMENT_DRIVER, PaymentError, type PaymentDriver } from './payment.driver';
import type { AuthorizePaymentDto, CapturePaymentDto, RefundPaymentDto } from './dto/payments.dto';

/** 결제 거래 코드. 폴리오에 올라갈 때 쓴다. */
const PAYMENT_TRANSACTION_CODE = '5000';

/**
 * 결제.
 *
 * 승인 → 매입 → (필요하면) 환불의 세 단계를 그대로 둔다. 하나로 합치면 "돈은
 * 빠져나갔는데 폴리오에는 없다" 또는 그 반대가 생겼을 때 어디서 끊겼는지 알 수
 * 없다.
 *
 * **폴리오에 결제가 올라가는 시점은 매입이다.** 승인만으로 잔액을 줄이면 매입에
 * 실패했을 때 받지도 않은 돈이 받은 것으로 남는다.
 *
 * 카드 번호와 CVV 는 어디에도 저장하지 않는다. 단말이 PG 에 직접 태우고 우리는
 * 결과 토큰만 받는다.
 */
@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly core: CoreClient,
    @Inject(PAYMENT_DRIVER) private readonly driver: PaymentDriver,
  ) {}

  async listByReservation(reservationId: string, user: AuthUser) {
    await this.assertReservationInScope(reservationId, user);

    const items = await this.prisma.payment.findMany({
      where: { folio: { reservationId } },
      include: { folio: { select: { window: true } } },
      orderBy: { createdAt: 'desc' },
    });

    return {
      reservationId,
      /** mock 이면 실제로 돈이 오가지 않는다. 화면이 알려야 한다. */
      driverMode: this.driver.mode,
      items,
    };
  }

  /**
   * 승인.
   *
   * 같은 멱등키로 다시 들어오면 새로 긁지 않고 이미 만든 것을 돌려준다. 손님
   * 돈이 두 번 나가는 일은 그 무엇보다 되돌리기 어렵다.
   */
  async authorize(
    reservationId: string,
    window: number,
    dto: AuthorizePaymentDto,
    user: AuthUser,
  ): Promise<Payment> {
    await this.assertReservationInScope(reservationId, user);

    const existing = await this.prisma.payment.findUnique({
      where: { idempotencyKey: dto.idempotencyKey },
    });
    if (existing) return existing;

    const folio = await this.prisma.folio.findUnique({
      where: { reservationId_window: { reservationId, window } },
    });
    if (!folio) {
      throw new NotFoundException(`폴리오를 찾을 수 없습니다: 윈도 ${window}`);
    }
    if (folio.status === FolioStatus.CLOSED) {
      throw new BadRequestException('마감된 폴리오에는 결제를 붙일 수 없습니다.');
    }

    const amount = new Prisma.Decimal(dto.amount);

    /*
     * 현금·계좌이체는 PG 를 거치지 않는다.
     *
     * 사람이 받아 확인한 돈이므로 승인 단계 없이 곧바로 매입 상태로 둔다. 굳이
     * 두 단계로 나누면 프런트가 "매입" 을 한 번 더 눌러야 하고, 그걸 잊으면
     * 받은 돈이 폴리오에 없다.
     */
    if (dto.method !== PaymentMethod.CARD) {
      const payment = await this.prisma.payment.create({
        data: {
          folioId: folio.id,
          method: dto.method,
          status: PaymentStatus.CAPTURED,
          amount,
          currency: folio.currency,
          idempotencyKey: dto.idempotencyKey,
          capturedAt: new Date(),
          createdById: user.id,
        },
      });
      await this.postPayment(reservationId, window, payment, amount, dto.description);
      return payment;
    }

    if (!dto.paymentToken) {
      throw new BadRequestException('카드 결제에는 결제 토큰이 필요합니다.');
    }

    let result;
    try {
      result = await this.driver.authorize({
        paymentToken: dto.paymentToken,
        amount: amount.toFixed(2),
        currency: folio.currency,
        idempotencyKey: dto.idempotencyKey,
        description: dto.description ?? '객실 정산',
      });
    } catch (error) {
      const declined = error instanceof PaymentError && error.declined;
      this.logger.warn(`승인 실패 (${declined ? '거절' : '결과 불명'}): ${describe(error)}`);

      // 거절은 이력을 남긴다. 같은 카드로 반복 시도했는지 나중에 확인해야 한다.
      if (declined) {
        await this.prisma.payment.create({
          data: {
            folioId: folio.id,
            method: dto.method,
            status: PaymentStatus.FAILED,
            amount,
            currency: folio.currency,
            idempotencyKey: dto.idempotencyKey,
            failureReason: describe(error),
            createdById: user.id,
          },
        });
        throw new BadRequestException(`결제가 거절되었습니다: ${describe(error)}`);
      }

      /*
       * 결과 불명은 이력을 남기지 않는다.
       *
       * 멱등키를 소진해 버리면 같은 키로 다시 시도할 수 없고, 실제로는 승인이
       * 났는지 여부를 확인할 방법도 막힌다. PG 조회로 확인하는 편이 맞다.
       */
      throw new BadRequestException(
        '결제 대행사 응답을 받지 못했습니다. 승인되었을 수 있으니 PG 관리자에서 확인해 주세요.',
      );
    }

    return this.prisma.payment.create({
      data: {
        folioId: folio.id,
        method: dto.method,
        status: PaymentStatus.AUTHORIZED,
        amount,
        currency: folio.currency,
        idempotencyKey: dto.idempotencyKey,
        vendorTxnId: result.vendorTxnId,
        approvalNumber: result.approvalNumber,
        maskedCard: result.maskedCard,
        cardBrand: result.cardBrand,
        createdById: user.id,
      },
    });
  }

  /** 매입. 이때 폴리오에 결제가 올라간다. */
  async capture(paymentId: string, dto: CapturePaymentDto, user: AuthUser): Promise<Payment> {
    const payment = await this.load(paymentId, user);

    if (payment.status !== PaymentStatus.AUTHORIZED) {
      throw new ConflictException(`승인 상태가 아닙니다(${payment.status}).`);
    }
    // 현금·이체는 승인 단계 없이 곧바로 매입되므로 여기에 올 수 없다. 방어적으로 막는다.
    if (!payment.vendorTxnId) {
      throw new BadRequestException('PG 를 거치지 않은 결제는 매입할 수 없습니다.');
    }

    const amount = dto.amount === undefined ? payment.amount : new Prisma.Decimal(dto.amount);
    if (amount.greaterThan(payment.amount)) {
      throw new BadRequestException('승인액을 초과하는 매입은 할 수 없습니다.');
    }

    try {
      await this.driver.capture(payment.vendorTxnId, amount.toFixed(2));
    } catch (error) {
      this.logger.warn(`매입 실패: ${describe(error)}`);
      throw new BadRequestException(`매입하지 못했습니다: ${describe(error)}`);
    }

    const updated = await this.prisma.payment.update({
      where: { id: payment.id },
      data: { status: PaymentStatus.CAPTURED, amount, capturedAt: new Date() },
    });

    const folio = await this.folioOf(payment.folioId);
    await this.postPayment(folio.reservationId, folio.window, updated, amount);
    return updated;
  }

  /** 승인 취소. 매입 전에만 된다. */
  async void(paymentId: string, user: AuthUser): Promise<Payment> {
    const payment = await this.load(paymentId, user);

    if (payment.status !== PaymentStatus.AUTHORIZED) {
      throw new ConflictException(
        `승인 상태가 아닙니다(${payment.status}). 매입된 건은 환불로 처리해 주세요.`,
      );
    }

    if (!payment.vendorTxnId) {
      throw new BadRequestException('PG 를 거치지 않은 결제는 승인 취소할 수 없습니다.');
    }

    try {
      await this.driver.void(payment.vendorTxnId);
    } catch (error) {
      this.logger.warn(`승인 취소 실패: ${describe(error)}`);
      throw new BadRequestException(`승인을 취소하지 못했습니다: ${describe(error)}`);
    }

    return this.prisma.payment.update({
      where: { id: payment.id },
      data: { status: PaymentStatus.VOIDED, voidedAt: new Date() },
    });
  }

  /**
   * 환불.
   *
   * 매입 후에 쓴다. 폴리오에는 반대 부호 포스팅이 하나 더 붙는다 — 원래 결제를
   * 지우면 손님 명세서에서 결제가 통째로 사라져 무엇이 정정됐는지 알 수 없다.
   */
  async refund(paymentId: string, dto: RefundPaymentDto, user: AuthUser): Promise<Payment> {
    const payment = await this.load(paymentId, user);

    if (payment.status !== PaymentStatus.CAPTURED && payment.status !== PaymentStatus.REFUNDED) {
      throw new ConflictException(`매입된 결제만 환불할 수 있습니다(현재 ${payment.status}).`);
    }

    const amount = new Prisma.Decimal(dto.amount);
    const remaining = payment.amount.sub(payment.refundedAmount);
    if (amount.greaterThan(remaining)) {
      throw new BadRequestException(
        `환불 가능 금액을 초과했습니다. 남은 금액: ${remaining.toString()}`,
      );
    }

    /*
     * 현금·이체는 PG 를 거치지 않았으므로 환불도 거치지 않는다.
     *
     * 부르면 PG 가 모르는 거래라며 거절해 현금 환불 자체가 막힌다. 실제 돈은
     * 프런트가 손으로 내주고, 여기서는 기록만 맞춘다.
     */
    if (payment.vendorTxnId) {
      try {
        await this.driver.refund(payment.vendorTxnId, amount.toFixed(2));
      } catch (error) {
        this.logger.warn(`환불 실패: ${describe(error)}`);
        throw new BadRequestException(`환불하지 못했습니다: ${describe(error)}`);
      }
    }

    const refunded = payment.refundedAmount.add(amount);
    const updated = await this.prisma.payment.update({
      where: { id: payment.id },
      data: { status: PaymentStatus.REFUNDED, refundedAmount: refunded },
    });

    const folio = await this.folioOf(payment.folioId);
    await this.postToFolio(folio.reservationId, folio.window, payment.id, {
      type: 'Adjustment',
      transactionCode: PAYMENT_TRANSACTION_CODE,
      description: `[환불] ${payment.maskedCard ?? payment.method}${dto.reason ? ` — ${dto.reason}` : ''}`,
      // 결제는 음수로 올라가 있으므로 환불은 양수다. Adjustment 의 기본 방향이다.
      amount: amount.toNumber(),
      reference: `PAY-${payment.id}-R${refunded.toFixed(0)}`,
    });

    return updated;
  }

  // ---------------------------------------------------------------------------

  /** 결제는 음수로 올라간다. 폴리오 잔액이 곧 거래 합계이기 때문이다. */
  private async postPayment(
    reservationId: string,
    window: number,
    payment: Payment,
    amount: Prisma.Decimal,
    description?: string,
  ): Promise<void> {
    await this.postToFolio(reservationId, window, payment.id, {
      type: 'Payment',
      transactionCode: PAYMENT_TRANSACTION_CODE,
      description:
        description ??
        `${payment.method} 결제${payment.maskedCard ? ` ${payment.maskedCard}` : ''}`,
      // 부호는 OPERA 가 종류로 정한다. 우리는 양수로 보낸다.
      amount: amount.toNumber(),
      reference: `PAY-${payment.id}`,
    });
  }

  /**
   * 폴리오 반영은 OPERA 를 거친다.
   *
   * 로컬에만 적으면 OPERA 의 계산서에는 결제가 없고 우리 잔액만 줄어든다.
   * 손님은 두 장의 다른 명세서를 받는다.
   *
   * 전표 번호에 결제 식별자를 넣어 재전송을 막는다 — 같은 결제가 두 번 올라가면
   * 받지 않은 돈이 받은 것으로 남는다.
   */
  private async postToFolio(
    reservationId: string,
    window: number,
    paymentId: string,
    input: CoreCreatePostingInput,
  ): Promise<void> {
    const reservation = await this.prisma.reservation.findUnique({
      where: { id: reservationId },
      include: { property: true },
    });
    if (!reservation?.operaReservationId) {
      throw new BadRequestException(
        'OPERA 와 연결되지 않은 예약입니다. 먼저 동기화한 뒤 다시 시도해 주세요.',
      );
    }

    const folio = await this.core.createPosting(reservation.operaReservationId, window, {
      hotelId: reservation.property.operaHotelId,
      ...input,
    });

    await this.prisma.$transaction(async (tx) => {
      await mirrorFolios(tx, reservationId, reservation.currency, [folio]);

      // 어느 결제가 만든 거래인지는 OPERA 가 모른다. 대사할 때 필요하다.
      const posting = await tx.posting.findFirst({
        where: { folio: { reservationId, window }, reference: input.reference },
      });
      if (posting && posting.paymentId !== paymentId) {
        await tx.posting.update({ where: { id: posting.id }, data: { paymentId } });
      }
    });
  }

  private async folioOf(folioId: string): Promise<{ reservationId: string; window: number }> {
    const folio = await this.prisma.folio.findUnique({
      where: { id: folioId },
      select: { reservationId: true, window: true },
    });
    if (!folio) {
      throw new NotFoundException(`폴리오를 찾을 수 없습니다: ${folioId}`);
    }
    return folio;
  }

  private async load(paymentId: string, user: AuthUser): Promise<Payment> {
    const payment = await this.prisma.payment.findUnique({
      where: { id: paymentId },
      include: { folio: { include: { reservation: { select: { propertyId: true } } } } },
    });
    if (!payment) {
      throw new NotFoundException(`결제를 찾을 수 없습니다: ${paymentId}`);
    }
    assertWithinScope(user, payment.folio.reservation.propertyId);
    return payment;
  }

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

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
