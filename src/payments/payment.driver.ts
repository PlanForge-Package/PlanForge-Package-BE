/**
 * 결제 대행사(PG) 드라이버.
 *
 * 국내만 해도 토스페이먼츠 · NHN KCP · 이니시스 · 나이스페이가 서로 다른 규약을
 * 쓴다. 그래서 여기 인터페이스만 도메인이 알고, 실제 통신은 구현체 한 파일에
 * 가둔다. PG 가 정해지면 그 파일 하나만 새로 쓰면 된다.
 *
 * **카드 번호와 CVV 는 이 경계를 넘어오지 않는다.** 단말이 PG 에 직접 태우고
 * 우리는 그 결과 토큰만 받는 것이 전제다. 번호를 받아 넘기는 순간 이 시스템이
 * 카드 정보 보관 설비가 되고 책임 범위가 달라진다.
 */
export interface AuthorizeRequest {
  /** 단말·결제창이 PG 에서 받아 온 일회성 토큰. 카드 번호가 아니다. */
  paymentToken: string;
  amount: string;
  currency: string;
  /** 재전송이 같은 결제로 취급되도록 하는 키. */
  idempotencyKey: string;
  /** PG 화면과 명세서에 찍히는 설명. */
  description: string;
}

export interface AuthorizeResult {
  vendorTxnId: string;
  approvalNumber: string;
  /** 뒷 네 자리만. 전체 번호는 받지 않는다. */
  maskedCard: string;
  cardBrand: string;
}

export interface PaymentDriver {
  readonly mode: 'mock' | 'live';
  authorize(request: AuthorizeRequest): Promise<AuthorizeResult>;
  /** 승인된 건을 실제로 청구한다. 금액은 승인액 이하만 가능하다. */
  capture(vendorTxnId: string, amount: string): Promise<void>;
  /** 매입 전 승인 취소. */
  void(vendorTxnId: string): Promise<void>;
  /** 매입 후 환불. 부분 환불을 여러 번 받을 수 있다. */
  refund(vendorTxnId: string, amount: string): Promise<void>;
}

export const PAYMENT_DRIVER = 'PAYMENT_DRIVER';

/**
 * PG 호출 실패.
 *
 * 거절(한도 초과·분실 카드)과 결과 불명(타임아웃)을 구분해야 한다. 전자는 다시
 * 시도해도 소용없고, 후자는 이미 승인이 났을 수 있어 재시도가 위험하다.
 */
export class PaymentError extends Error {
  constructor(
    message: string,
    /** true 면 PG 가 명확히 거절한 것이다. false 면 결과를 알 수 없다. */
    readonly declined: boolean,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'PaymentError';
  }
}
