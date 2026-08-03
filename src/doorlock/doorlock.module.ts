import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DoorLockController } from './doorlock.controller';
import { DOOR_LOCK_DRIVER, type DoorLockDriver } from './doorlock.driver';
import { DoorLockService } from './doorlock.service';
import { MockDoorLockDriver } from './mock-doorlock.driver';

/**
 * 잠금장치 드라이버 선택.
 *
 * `DOORLOCK_MODE=live` 가 아니면 모의 드라이버를 쓴다. 모의로 발급한 카드로는
 * 어떤 문도 열리지 않으므로 **운영에서는 기동을 막는다** — 프런트가 카드를
 * 발급했다고 믿는데 손님이 방에 못 들어가는 상황이 최악이다.
 *
 * 벤더가 정해지면 그 벤더용 드라이버를 하나 만들고 여기 분기만 늘리면 된다.
 * 도메인 코드는 손대지 않는다.
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
    // 벤더 드라이버가 아직 없다. 잘못 켜고 운영에 올리는 것을 막는다.
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
