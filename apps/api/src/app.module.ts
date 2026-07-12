import { Module } from '@nestjs/common';
import { AuthController } from './auth/auth.controller';
import { ConfigController } from './config.controller';
import { UploadController } from './upload.controller';
import { SignalingGateway } from './gateway/signaling.gateway';
import { UploadsService } from './uploads';

@Module({
  controllers: [AuthController, ConfigController, UploadController],
  providers: [SignalingGateway, UploadsService],
})
export class AppModule {}
