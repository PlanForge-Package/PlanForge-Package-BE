/**
 * 잠금장치 벤더 드라이버.
 *
 * 벤더마다 프로토콜이 완전히 다르다 — Assa Abloy(Vingcard)·Salto·Onity 는 카드
 * 인코딩 방식도, 연결 방식(로컬 인코더 SDK · 온프레미스 서버 · 클라우드 API)도
 * 서로 맞지 않는다. 그래서 **여기 인터페이스만 도메인이 알고**, 실제 통신은
 * 구현체 한 파일에 가둔다. 벤더가 정해지면 그 파일 하나만 새로 쓰면 된다.
 *
 * 도메인이 벤더에게 요구하는 것은 두 가지뿐이다: 카드를 만들고, 죽이는 것.
 */
export interface EncodeKeyRequest {
  /** 호텔 식별자. 벤더 시스템은 대개 체인 단위로 물려 있다. */
  propertyCode: string;
  roomNumber: string;
  validFrom: Date;
  validUntil: Date;
  /** 재발급 차수. 벤더에 따라 이전 카드를 자동으로 무효화하는 근거가 된다. */
  sequence: number;
}

export interface EncodeKeyResult {
  /** 벤더 시스템의 카드 식별자. 무효화할 때 이 값으로 지정한다. */
  vendorKeyId: string;
}

export interface DoorLockDriver {
  readonly mode: 'mock' | 'live';
  encode(request: EncodeKeyRequest): Promise<EncodeKeyResult>;
  revoke(vendorKeyId: string): Promise<void>;
}

/** 드라이버 주입 토큰. */
export const DOOR_LOCK_DRIVER = 'DOOR_LOCK_DRIVER';

/**
 * 잠금장치에 닿지 못했을 때.
 *
 * 카드가 만들어졌는지 알 수 없는 상태와, 확실히 거절당한 상태를 구분해야 한다.
 * 전자는 재시도가 위험하고(중복 카드) 후자는 안전하다.
 */
export class DoorLockError extends Error {
  constructor(
    message: string,
    /** true 면 벤더가 명확히 거절한 것이다. false 면 결과를 알 수 없다. */
    readonly rejected: boolean,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'DoorLockError';
  }
}
