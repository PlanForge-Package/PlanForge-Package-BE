import { Injectable, Logger } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import {
  PaymentError,
  type AuthorizeRequest,
  type AuthorizeResult,
  type PaymentDriver,
} from './payment.driver';

/**
 * Mock PSP.
 *
 * Lets the whole authorise, capture, void and refund flow be developed and verified
 * without merchant credentials. **No money actually moves.**
 *
 * The outcome can be chosen by token prefix. Without actually exercising the decline
 * paths there is no telling whether the screens handle them.
 *
 * - `tok_decline_*` → declined
 * - `tok_timeout_*` → outcome unknown
 * - anything else → authorised
 */
@Injectable()
export class MockPaymentDriver implements PaymentDriver {
  readonly mode = 'mock' as const;
  private readonly logger = new Logger(MockPaymentDriver.name);

  /** Authorised transactions. Kept only for the life of the process. */
  private readonly transactions = new Map<string, { amount: string; captured: boolean }>();

  async authorize(request: AuthorizeRequest): Promise<AuthorizeResult> {
    if (request.paymentToken.startsWith('tok_decline')) {
      throw new PaymentError('카드사에서 거절했습니다 (한도 초과)', true);
    }
    if (request.paymentToken.startsWith('tok_timeout')) {
      throw new PaymentError('결제 대행사 응답이 없습니다', false);
    }

    const vendorTxnId = `MOCKTXN-${randomBytes(6).toString('hex').toUpperCase()}`;
    this.transactions.set(vendorTxnId, { amount: request.amount, captured: false });

    this.logger.debug(`모의 승인: ${vendorTxnId} ${request.amount} ${request.currency}`);
    return {
      vendorTxnId,
      approvalNumber: randomBytes(4).toString('hex').toUpperCase(),
      maskedCard: `**** **** **** ${randomBytes(2).toString('hex').slice(0, 4)}`,
      cardBrand: 'MOCKCARD',
    };
  }

  async capture(vendorTxnId: string, amount: string): Promise<void> {
    const txn = this.transactions.get(vendorTxnId);
    if (!txn) {
      throw new PaymentError(`알 수 없는 거래입니다: ${vendorTxnId}`, true);
    }
    if (txn.captured) {
      throw new PaymentError('이미 매입된 거래입니다.', true);
    }
    // A real PSP also refuses a capture above the authorised amount.
    if (Number(amount) > Number(txn.amount)) {
      throw new PaymentError('승인액을 초과하는 매입은 할 수 없습니다.', true);
    }

    txn.captured = true;
    this.logger.debug(`모의 매입: ${vendorTxnId} ${amount}`);
  }

  async void(vendorTxnId: string): Promise<void> {
    const txn = this.transactions.get(vendorTxnId);
    if (!txn) {
      throw new PaymentError(`알 수 없는 거래입니다: ${vendorTxnId}`, true);
    }
    if (txn.captured) {
      throw new PaymentError('이미 매입된 거래는 취소할 수 없습니다. 환불로 처리해 주세요.', true);
    }

    this.transactions.delete(vendorTxnId);
    this.logger.debug(`모의 승인 취소: ${vendorTxnId}`);
  }

  async refund(vendorTxnId: string, amount: string): Promise<void> {
    const txn = this.transactions.get(vendorTxnId);
    if (!txn) {
      throw new PaymentError(`알 수 없는 거래입니다: ${vendorTxnId}`, true);
    }
    if (!txn.captured) {
      throw new PaymentError('매입되지 않은 거래는 환불할 수 없습니다. 승인 취소를 쓰세요.', true);
    }

    this.logger.debug(`모의 환불: ${vendorTxnId} ${amount}`);
  }

  /** Used by tests to reset the state. */
  reset(): void {
    this.transactions.clear();
  }
}
