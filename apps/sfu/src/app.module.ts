import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { SfuGateway } from './gateway/sfu.gateway';
import { RoomsService } from './media/rooms.service';
import { WorkersService } from './media/workers.service';

@Module({
  controllers: [HealthController],
  providers: [WorkersService, RoomsService, SfuGateway],
})
export class AppModule {}
