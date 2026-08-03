import { Injectable, Logger } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import {
  PaymentError,
  type AuthorizeRequest,
  type AuthorizeResult,
  type PaymentDriver,
} from './payment.driver';

/**
 * 모의 PG.
 *
 * 가맹점 자격 증명 없이도 승인·매입·취소·환불 흐름 전체를 개발·검증하기 위해
 * 둔다. **실제로 돈이 오가지 않는다.**
 *
 * 토큰 접두사로 결과를 정할 수 있게 해 두었다. 거절 경로를 실제로 태워 보지
 * 않으면 화면이 그 상황을 제대로 다루는지 알 수 없기 때문이다.
 *
 * - `tok_decline_*` → 거절
 * - `tok_timeout_*` → 결과 불명
 * - 그 밖 → 승인
 */
@Injectable()
export class MockPaymentDriver implements PaymentDriver {
  readonly mode = 'mock' as const;
  private readonly logger = new Logger(MockPaymentDriver.name);

  /** 승인된 거래. 프로세스가 살아 있는 동안만 유지된다. */
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
    // 실제 PG 도 승인액을 넘는 매입은 거절한다.
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

  /** 테스트가 상태를 초기화할 때 쓴다. */
  reset(): void {
    this.transactions.clear();
  }
}
