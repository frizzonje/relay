import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { announcedIp } from './media/media.config';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const port = process.env.PORT ?? 3100;
  await app.listen(port);

  if (!(process.env.SFU_SECRET ?? '').trim()) {
    console.error(
      '⚠️  SFU_SECRET не задан — медиасервер не пустит никого: ' +
        'подписать пропуск таким ключом смог бы кто угодно. ' +
        'Задайте тот же SFU_SECRET, что и у api.',
    );
  }
  if (!announcedIp()) {
    console.warn(
      '⚠️  Ни SFU_ANNOUNCED_IP, ни TURN_EXTERNAL_IP, ни IP-литерал в SERVER_HOST не заданы — ' +
        'в ICE-кандидатах уйдёт адрес контейнера. Локально это работает, на облачной VM за NAT — нет.',
    );
  }
  console.log(`SFU listening on http://localhost:${port} (socket path /sfu/)`);
}

bootstrap();
