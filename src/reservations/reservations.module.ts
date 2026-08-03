import { Module } from '@nestjs/common';
import { DoorLockModule } from '../doorlock/doorlock.module';
import { BookingService } from './booking.service';
import { ReservationsController } from './reservations.controller';
import { ReservationsService } from './reservations.service';

@Module({
  imports: [DoorLockModule],
  controllers: [ReservationsController],
  providers: [ReservationsService, BookingService],
  exports: [ReservationsService, BookingService],
})
export class ReservationsModule {}
