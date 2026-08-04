import { Module } from '@nestjs/common';
import { RoomOutagesController } from './room-outages.controller';
import { RoomOutagesService } from './room-outages.service';

@Module({
  controllers: [RoomOutagesController],
  providers: [RoomOutagesService],
  exports: [RoomOutagesService],
})
export class RoomOutagesModule {}
