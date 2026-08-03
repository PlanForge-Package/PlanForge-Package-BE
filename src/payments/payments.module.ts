import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MockPaymentDriver } from './mock-payment.driver';
import { PAYMENT_DRIVER, type PaymentDriver } from './payment.driver';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';

/**
 * PG 드라이버 선택.
 *
 * `PAYMENT_MODE=live` 가 아니면 모의 드라이버를 쓴다. 모의로는 실제로 돈이
 * 오가지 않으므로 **운영에서는 기동을 막는다** — 프런트가 결제됐다고 믿는데
 * 돈은 들어오지 않은 상황이 최악이다.
 */
export function createPaymentDriver(config: ConfigService): PaymentDriver {
  const mode = config.get<string>('PAYMENT_MODE') === 'live' ? 'live' : 'mock';

  if (mode !== 'live' && config.get<string>('NODE_ENV') === 'production') {
    throw new Error(
      '운영 환경에서는 PAYMENT_MODE=live 여야 합니다. 모의 드라이버로는 돈이 오가지 않습니다.',
    );
  }

  if (mode === 'live') {
    // PG 드라이버가 아직 없다. 잘못 켜고 운영에 올리는 것을 막는다.
    throw new Error(
      'PAYMENT_MODE=live 로 쓸 수 있는 결제 드라이버가 아직 없습니다. ' +
        'PG 를 정하고 PaymentDriver 구현체를 추가해 주세요.',
    );
  }

  return new MockPaymentDriver();
}

@Module({
  controllers: [PaymentsController],
  providers: [
    PaymentsService,
    { provide: PAYMENT_DRIVER, useFactory: createPaymentDriver, inject: [ConfigService] },
  ],
  exports: [PaymentsService],
})
export class PaymentsModule {}
