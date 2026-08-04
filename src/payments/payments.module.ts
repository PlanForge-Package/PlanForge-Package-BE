import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MockPaymentDriver } from './mock-payment.driver';
import { PAYMENT_DRIVER, type PaymentDriver } from './payment.driver';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';

/**
 * PSP driver selection.
 *
 * Anything other than `PAYMENT_MODE=live` uses the mock driver. No money actually
 * moves in mock, so **booting is blocked in production** — the front desk believing
 * a payment went through while no money arrived is the worst outcome.
 */
export function createPaymentDriver(config: ConfigService): PaymentDriver {
  const mode = config.get<string>('PAYMENT_MODE') === 'live' ? 'live' : 'mock';

  if (mode !== 'live' && config.get<string>('NODE_ENV') === 'production') {
    throw new Error(
      '운영 환경에서는 PAYMENT_MODE=live 여야 합니다. 모의 드라이버로는 돈이 오가지 않습니다.',
    );
  }

  if (mode === 'live') {
    // There is no PSP driver yet. This stops it being switched on in production.
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
