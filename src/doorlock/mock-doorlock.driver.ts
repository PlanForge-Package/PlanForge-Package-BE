import { Injectable, Logger } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import {
  DoorLockError,
  type DoorLockDriver,
  type EncodeKeyRequest,
  type EncodeKeyResult,
} from './doorlock.driver';

/**
 * Mock door lock.
 *
 * Lets the whole issue-and-void flow be developed and verified without a vendor
 * or hardware. No real card is made — **a key issued by this driver opens no
 * door.**
 *
 * Once a vendor is chosen, add one more implementation of this interface and switch
 * the mode. The domain code is untouched.
 */
@Injectable()
export class MockDoorLockDriver implements DoorLockDriver {
  readonly mode = 'mock' as const;
  private readonly logger = new Logger(MockDoorLockDriver.name);

  /** Issued cards. Kept only for the life of the process. */
  private readonly issued = new Map<string, EncodeKeyRequest>();

  async encode(request: EncodeKeyRequest): Promise<EncodeKeyResult> {
    // A real encoder refuses this too. Without it here there is no way to check that
    // the domain's own validation actually works.
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
     * Killing an unknown card is treated as success.
     *
     * Voiding has to be idempotent — returning failure for a card that is already gone
     * means a retry never succeeds and a lost card stays alive.
     */
    this.issued.delete(vendorKeyId);
    this.logger.debug(`Mock key void: ${vendorKeyId}`);
  }

  /** Used by tests to reset the state. */
  reset(): void {
    this.issued.clear();
  }
}
