/**
 * Payment service provider (PSP) driver.
 *
 * In Korea alone, Toss Payments, NHN KCP, Inicis and NicePay all speak different
 * protocols. So the domain knows only this interface and the actual traffic is
 * confined to one implementation file. Choosing a PSP means rewriting that file.
 *
 * **Card numbers and CVV never cross this boundary.** The premise is that the
 * terminal talks to the PSP directly and we receive only the resulting token.
 * Accepting numbers turns this system into card-data storage.
 */
export interface AuthorizeRequest {
  /** One-time token the terminal or payment window got from the PSP. Not a card number. */
  paymentToken: string;
  amount: string;
  currency: string;
  /** Key that makes a resend count as the same payment. */
  idempotencyKey: string;
  /** Description shown on the PSP screen and the statement. */
  description: string;
}

export interface AuthorizeResult {
  vendorTxnId: string;
  approvalNumber: string;
  /** Last four only. The full number is never received. */
  maskedCard: string;
  cardBrand: string;
}

export interface PaymentDriver {
  readonly mode: 'mock' | 'live';
  authorize(request: AuthorizeRequest): Promise<AuthorizeResult>;
  /** Charges an authorised payment for real. At most the authorised amount. */
  capture(vendorTxnId: string, amount: string): Promise<void>;
  /** Voids an authorisation before capture. */
  void(vendorTxnId: string): Promise<void>;
  /** Refunds after capture. Several partial refunds are possible. */
  refund(vendorTxnId: string, amount: string): Promise<void>;
}

export const PAYMENT_DRIVER = 'PAYMENT_DRIVER';

/**
 * PSP call failure.
 *
 * A decline (limit exceeded, lost card) and an unknown outcome (timeout) must be
 * told apart. Retrying the first is pointless; retrying the second is dangerous.
 */
export class PaymentError extends Error {
  constructor(
    message: string,
    /** True when the PSP clearly declined. False means the outcome is unknown. */
    readonly declined: boolean,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'PaymentError';
  }
}
