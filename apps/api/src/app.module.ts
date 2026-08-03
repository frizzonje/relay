import { Module } from '@nestjs/common';
import { AuthController } from './auth/auth.controller';
import { ConfigController } from './config.controller';
import { MetricsController } from './metrics.controller';
import { UploadController } from './upload.controller';
import { SignalingGateway } from './gateway/signaling.gateway';
import { MetricsService } from './metrics';
import { UploadsService } from './uploads';

@Module({
  controllers: [AuthController, ConfigController, MetricsController, UploadController],
  providers: [SignalingGateway, MetricsService, UploadsService],
})
export class AppModule {}
