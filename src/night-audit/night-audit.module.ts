import { Module } from '@nestjs/common';
import { HousekeepingModule } from '../housekeeping/housekeeping.module';
import { ReservationsModule } from '../reservations/reservations.module';
import { NightAuditController } from './night-audit.controller';
import { NightAuditService } from './night-audit.service';

@Module({
  imports: [HousekeepingModule, ReservationsModule],
  controllers: [NightAuditController],
  providers: [NightAuditService],
})
export class NightAuditModule {}
