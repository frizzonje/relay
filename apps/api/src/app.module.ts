import { Module } from '@nestjs/common';
import { AuthController } from './auth/auth.controller';
import { ConfigController } from './config.controller';
import { HealthController } from './health.controller';
import { MetricsController } from './metrics.controller';
import { UploadController } from './upload.controller';
import { SignalingGateway } from './gateway/signaling.gateway';
import { ChatService } from './gateway/chat.service';
import { RegistryService } from './gateway/registry.service';
import { MetricsService } from './metrics';
import { UploadsService } from './uploads';

@Module({
  controllers: [
    AuthController,
    ConfigController,
    HealthController,
    MetricsController,
    UploadController,
  ],
  providers: [SignalingGateway, ChatService, RegistryService, MetricsService, UploadsService],
})
export class AppModule {}
