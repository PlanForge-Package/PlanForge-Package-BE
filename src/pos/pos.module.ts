import { Module } from '@nestjs/common';
import { OutletsController } from './outlets.controller';
import { OutletsService } from './outlets.service';
import { PosController } from './pos.controller';
import { PosKeyGuard } from './pos-key.guard';
import { PosService } from './pos.service';

@Module({
  controllers: [PosController, OutletsController],
  providers: [PosService, OutletsService, PosKeyGuard],
})
export class PosModule {}
