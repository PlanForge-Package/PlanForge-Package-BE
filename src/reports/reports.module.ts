import { Module } from '@nestjs/common';
import { JournalService } from './journal.service';
import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';

@Module({
  controllers: [ReportsController],
  providers: [ReportsService, JournalService],
})
export class ReportsModule {}
