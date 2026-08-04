/**
 * Door lock vendor driver.
 *
 * Protocols differ completely by vendor — Assa Abloy (Vingcard), Salto and Onity
 * disagree on card encoding and on how you connect at all (local encoder SDK,
 * on-premise server, cloud API). So **the domain knows only this interface** and
 * the traffic is confined to one implementation file. Choosing a vendor rewrites it.
 *
 * The domain asks a vendor for two things only: make a card, and kill one.
 */
export interface EncodeKeyRequest {
  /** Hotel identifier. Vendor systems are usually wired per chain. */
  propertyCode: string;
  roomNumber: string;
  validFrom: Date;
  validUntil: Date;
  /** Reissue count. Some vendors use it to void the previous card automatically. */
  sequence: number;
}

export interface EncodeKeyResult {
  /** Vendor's card id. Voiding is issued against this value. */
  vendorKeyId: string;
}

export interface DoorLockDriver {
  readonly mode: 'mock' | 'live';
  encode(request: EncodeKeyRequest): Promise<EncodeKeyResult>;
  revoke(vendorKeyId: string): Promise<void>;
}

/** Driver injection token. */
export const DOOR_LOCK_DRIVER = 'DOOR_LOCK_DRIVER';

/**
 * When the lock could not be reached.
 *
 * Not knowing whether the card was made must be told apart from a clear refusal.
 * Retrying the first is dangerous (duplicate cards); the second is safe.
 */
export class DoorLockError extends Error {
  constructor(
    message: string,
    /** True when the vendor clearly refused. False means the outcome is unknown. */
    readonly rejected: boolean,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'DoorLockError';
  }
}
