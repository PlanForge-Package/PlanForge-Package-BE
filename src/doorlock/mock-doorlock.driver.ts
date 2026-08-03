import { Injectable, Logger } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import {
  DoorLockError,
  type DoorLockDriver,
  type EncodeKeyRequest,
  type EncodeKeyResult,
} from './doorlock.driver';

/**
 * 모의 잠금장치.
 *
 * 벤더와 하드웨어가 없어도 발급·무효화 흐름 전체를 개발·검증하기 위해 둔다.
 * 실제 카드는 만들어지지 않는다 — **이 드라이버로 발급한 키로는 어떤 문도
 * 열리지 않는다.**
 *
 * 벤더가 정해지면 이 파일과 같은 인터페이스로 구현체를 하나 더 만들고 모드만
 * 바꾸면 된다. 도메인 코드는 손대지 않는다.
 */
@Injectable()
export class MockDoorLockDriver implements DoorLockDriver {
  readonly mode = 'mock' as const;
  private readonly logger = new Logger(MockDoorLockDriver.name);

  /** 발급된 카드. 프로세스가 살아 있는 동안만 유지된다. */
  private readonly issued = new Map<string, EncodeKeyRequest>();

  async encode(request: EncodeKeyRequest): Promise<EncodeKeyResult> {
    // 실제 인코더도 거부하는 조건이다. 여기서 막지 않으면 도메인의 검증이
    // 실제로 동작하는지 확인할 수 없다.
    if (request.validUntil <= request.validFrom) {
      throw new DoorLockError('유효 종료 시각이 시작 시각보다 뒤여야 합니다.', true);
    }

    const vendorKeyId = `MOCKKEY-${randomBytes(6).toString('hex').toUpperCase()}`;
    this.issued.set(vendorKeyId, request);

    this.logger.debug(
      `모의 카드 발급: ${request.roomNumber}호 ${vendorKeyId} ` +
        `(${request.validFrom.toISOString()} ~ ${request.validUntil.toISOString()})`,
    );
    return { vendorKeyId };
  }

  async revoke(vendorKeyId: string): Promise<void> {
    /*
     * 모르는 카드를 죽이라는 요청은 성공으로 처리한다.
     *
     * 무효화는 멱등해야 한다 — 이미 없는 카드에 실패를 돌려주면 재시도가 영원히
     * 성공하지 못하고, 분실 카드가 살아 있는 채로 남는다.
     */
    this.issued.delete(vendorKeyId);
    this.logger.debug(`모의 카드 무효화: ${vendorKeyId}`);
  }

  /** 테스트가 상태를 초기화할 때 쓴다. */
  reset(): void {
    this.issued.clear();
  }
}
