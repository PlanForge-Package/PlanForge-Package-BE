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

/** Payment transaction code, used when posting to the folio. */
const PAYMENT_TRANSACTION_CODE = '5000';

/**
 * Payments.
 *
 * Authorise, capture and refund stay as three steps. Merged into one, there is no
 * way to tell where it broke when money left but the folio has no payment, or
 * the other way round.
 *
 * **A payment lands on the folio at capture.** Reducing the balance on the
 * authorisation alone leaves money we never took recorded as taken.
 *
 * Card numbers and CVV are never stored anywhere. The terminal talks to the PSP
 * directly and we keep only the resulting token.
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
      /** In mock mode no money actually moves. The screen has to say so. */
      driverMode: this.driver.mode,
      items,
    };
  }

  /**
   * Authorisation.
   *
   * The same idempotency key returns the existing record instead of charging
   * again. Money leaving a guest twice is harder to undo than anything else.
   */
  async authorize(
    reservationId: string,
    window: number,
    dto: AuthorizePaymentDto,
    user: AuthUser,
  ): Promise<Payment> {
    const propertyId = await this.assertReservationInScope(reservationId, user);

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
     * Cash and bank transfer do not go through the PSP.
     *
     * A person took and checked the money, so it goes straight to captured. Split
     * into two steps, the front desk has to press "capture" again, and forgetting
     * leaves money taken but absent from the folio.
     */
    const shiftId = await this.openShiftId(user);

    if (dto.method !== PaymentMethod.CARD) {
      const payment = await this.prisma.payment.create({
        data: {
          folioId: folio.id,
          propertyId,
          method: dto.method,
          status: PaymentStatus.CAPTURED,
          amount,
          currency: folio.currency,
          idempotencyKey: dto.idempotencyKey,
          capturedAt: new Date(),
          createdById: user.id,
          shiftId,
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
      this.logger.warn(`Authorisation failed (${declined ? 'declined' : 'outcome unknown'}): ${describe(error)}`);

      // Declines are logged. Repeated attempts on one card need to be traceable.
      if (declined) {
        await this.prisma.payment.create({
          data: {
            folioId: folio.id,
            propertyId,
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
       * An unknown outcome is not recorded.
       *
       * Burning the idempotency key blocks retrying with it and also blocks
       * finding out whether the authorisation went through. Ask the PSP instead.
       */
      throw new BadRequestException(
        '결제 대행사 응답을 받지 못했습니다. 승인되었을 수 있으니 PG 관리자에서 확인해 주세요.',
      );
    }

    return this.prisma.payment.create({
      data: {
        folioId: folio.id,
        propertyId,
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
        shiftId,
      },
    });
  }

  /**
   * My currently open shift.
   *
   * Taking money without opening a shift is allowed — we cannot keep a guest
   * waiting to "open a shift first". Such a receipt belongs to no shift and so
   * falls outside the closing totals.
   */
  private async openShiftId(user: AuthUser): Promise<string | undefined> {
    const shift = await this.prisma.cashierShift.findFirst({
      where: { userId: user.id, closedAt: null },
      select: { id: true },
      orderBy: { openedAt: 'desc' },
    });
    return shift?.id;
  }

  /** Capture. This is when the payment lands on the folio. */
  async capture(paymentId: string, dto: CapturePaymentDto, user: AuthUser): Promise<Payment> {
    const payment = await this.load(paymentId, user);

    if (payment.status !== PaymentStatus.AUTHORIZED) {
      throw new ConflictException(`승인 상태가 아닙니다(${payment.status}).`);
    }
    // Cash and transfer capture immediately, so they never reach here. Guarded anyway.
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
      this.logger.warn(`Capture failed: ${describe(error)}`);
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

  /** Void. Only possible before capture. */
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
      this.logger.warn(`Void failed: ${describe(error)}`);
      throw new BadRequestException(`승인을 취소하지 못했습니다: ${describe(error)}`);
    }

    return this.prisma.payment.update({
      where: { id: payment.id },
      data: { status: PaymentStatus.VOIDED, voidedAt: new Date() },
    });
  }

  /**
   * Refund.
   *
   * Used after capture. A second posting with the opposite sign is added — deleting
   * the original would remove the payment from the guest's bill entirely.
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
     * Cash and transfer never went through the PSP, so the refund does not either.
     *
     * Called anyway, the PSP rejects an unknown transaction and blocks the cash
     * refund. The front desk hands the money over; here we only match the record.
     */
    if (payment.vendorTxnId) {
      try {
        await this.driver.refund(payment.vendorTxnId, amount.toFixed(2));
      } catch (error) {
        this.logger.warn(`Refund failed: ${describe(error)}`);
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
      // Payments are negative, so a refund is positive — the Adjustment default.
      amount: amount.toNumber(),
      reference: `PAY-${payment.id}-R${refunded.toFixed(0)}`,
    });

    return updated;
  }

  // ---------------------------------------------------------------------------

  /** Payments post negative, because the folio balance is the sum of transactions. */
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
      // OPERA sets the sign from the type. We send a positive amount.
      amount: amount.toNumber(),
      reference: `PAY-${payment.id}`,
    });
  }

  /**
   * The folio is updated through OPERA.
   *
   * Written locally only, OPERA's bill has no payment while our balance drops.
   * The guest receives two different statements.
   *
   * The payment id goes in the check number to stop resends — posting the same
   * payment twice records money we never took as taken.
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

      // OPERA does not know which payment made the posting. Needed when reconciling.
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

  /** Checks the hotel scope and hands back the hotel, which payments are stamped with. */
  private async assertReservationInScope(reservationId: string, user: AuthUser): Promise<string> {
    const reservation = await this.prisma.reservation.findUnique({
      where: { id: reservationId },
      select: { propertyId: true },
    });
    if (!reservation) {
      throw new NotFoundException(`예약을 찾을 수 없습니다: ${reservationId}`);
    }
    assertWithinScope(user, reservation.propertyId);
    return reservation.propertyId;
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
