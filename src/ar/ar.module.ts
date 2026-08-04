import { Module } from '@nestjs/common';
import { ArController, ReservationArController } from './ar.controller';
import { ArService } from './ar.service';

@Module({
  controllers: [ArController, ReservationArController],
  providers: [ArService],
  exports: [ArService],
})
export class ArModule {}
