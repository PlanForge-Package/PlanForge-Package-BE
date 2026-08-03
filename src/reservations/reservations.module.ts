import { Module } from '@nestjs/common';
import { BookingService } from './booking.service';
import { ReservationsController } from './reservations.controller';
import { ReservationsService } from './reservations.service';

@Module({
  controllers: [ReservationsController],
  providers: [ReservationsService, BookingService],
  exports: [ReservationsService, BookingService],
})
export class ReservationsModule {}
