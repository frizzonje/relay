import { Module, type DynamicModule } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { AuthController } from './auth/auth.controller';
import { DevicesController } from './identity/devices.controller';
import { IdentityController } from './identity/identity.controller';
import { IdentityService } from './identity/identity.service';
import { OwnerController } from './identity/owner.controller';
import { OwnerService } from './identity/owner.service';
import { PairingService } from './identity/pairing.service';
import { ConfigController } from './config.controller';
import { HealthController } from './health.controller';
import { MetricsController } from './metrics.controller';
import { UploadController } from './upload.controller';
import { SignalingGateway } from './gateway/signaling.gateway';
import { ChatService } from './gateway/chat.service';
import { RegistryService } from './gateway/registry.service';
import { MetricsService } from './metrics';
import { RetentionService } from './db/retention.service';
import { UploadsService } from './uploads';

/**
 * Модуль собирается вокруг уже открытой базы, а не открывает её сам.
 *
 * Порядок здесь — не вкусовщина: соединение и миграции обязаны отработать ДО
 * того, как поднимется хоть один провайдер, иначе первый же сокет придёт в
 * полусхему. Поэтому DataSource приходит снаружи готовым (см. `main.ts`), а
 * модуль его только раздаёт.
 */
@Module({})
export class AppModule {
  static withDatabase(db: DataSource): DynamicModule {
    return {
      module: AppModule,
      controllers: [
        AuthController,
        IdentityController,
        DevicesController,
        OwnerController,
        ConfigController,
        HealthController,
        MetricsController,
        UploadController,
      ],
      providers: [
        { provide: DataSource, useValue: db },
        SignalingGateway,
        ChatService,
        IdentityService,
        OwnerService,
        PairingService,
        RegistryService,
        MetricsService,
        RetentionService,
        UploadsService,
      ],
    };
  }
}
