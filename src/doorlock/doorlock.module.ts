import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DoorLockController } from './doorlock.controller';
import { DOOR_LOCK_DRIVER, type DoorLockDriver } from './doorlock.driver';
import { DoorLockService } from './doorlock.service';
import { MockDoorLockDriver } from './mock-doorlock.driver';

/**
 * Door lock driver selection.
 *
 * Anything other than `DOORLOCK_MODE=live` uses the mock driver. A mock card opens
 * no door, so **booting is blocked in production** — the front desk believing a key
 * was issued while the guest cannot get into the room is the worst outcome.
 *
 * Once a vendor is chosen, add a driver for it and extend the branch here. The
 * domain code is untouched.
 */
export function createDoorLockDriver(config: ConfigService): DoorLockDriver {
  const mode = config.get<string>('DOORLOCK_MODE') === 'live' ? 'live' : 'mock';

  if (mode !== 'live' && config.get<string>('NODE_ENV') === 'production') {
    throw new Error(
      '운영 환경에서는 DOORLOCK_MODE=live 여야 합니다. ' +
        '모의 드라이버로 발급한 카드로는 문이 열리지 않습니다.',
    );
  }

  if (mode === 'live') {
    // There is no vendor driver yet. This stops it being switched on in production.
    throw new Error(
      'DOORLOCK_MODE=live 로 쓸 수 있는 잠금장치 드라이버가 아직 없습니다. ' +
        '벤더를 정하고 DoorLockDriver 구현체를 추가해 주세요.',
    );
  }

  return new MockDoorLockDriver();
}

@Module({
  controllers: [DoorLockController],
  providers: [
    DoorLockService,
    { provide: DOOR_LOCK_DRIVER, useFactory: createDoorLockDriver, inject: [ConfigService] },
  ],
  exports: [DoorLockService],
})
export class DoorLockModule {}
