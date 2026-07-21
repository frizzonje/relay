import { Controller, Get } from '@nestjs/common';
import { sfuConfigured } from './sfu/sfu-token';

interface IceServer {
  urls: string[];
  username?: string;
  credential?: string;
}

function splitUrls(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

@Controller('api')
export class ConfigController {
  @Get('config')
  getConfig(): { iceServers: IceServer[]; sfu: { available: boolean } } {
    const iceServers: IceServer[] = [];

    // Без TURN звонок не соберётся между «строгими» NAT (мобильные сети и т.п.)
    const credential = process.env.TURN_CREDENTIAL ?? '';
    const username = process.env.TURN_USERNAME || 'webrtc';
    const host = process.env.SERVER_HOST;
    // Свой coturn поднят (профиль turn): у него есть учётка и публичный хост.
    const haveOwnTurn = !!credential && !!host && host !== 'localhost';

    // STUN: явный список приоритетен. Иначе — свой coturn (он же отвечает как STUN
    // на 3478, лишняя внешняя зависимость ни к чему) + публичные Google как резерв
    // на случай, если свой недоступен.
    const stunUrls = splitUrls(process.env.STUN_URLS);
    if (stunUrls.length) {
      iceServers.push({ urls: stunUrls });
    } else {
      const urls: string[] = [];
      if (haveOwnTurn) urls.push(`stun:${host}:3478`);
      urls.push('stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302');
      iceServers.push({ urls });
    }

    // Явный список имеет приоритет. Если он не задан, но есть учётка и хост —
    // собираем стандартные URL для coturn из docker-compose. Кроме UDP+TCP на
    // 3478 отдаём turns: (TURN over TLS) на 5349 — на строгих сетях с DPI, где
    // проходит только TLS, это единственный путь собрать звонок.
    let turnUrls = splitUrls(process.env.TURN_URLS);
    if (!turnUrls.length && haveOwnTurn) {
      turnUrls = [
        `turn:${host}:3478?transport=udp`,
        `turn:${host}:3478?transport=tcp`,
        `turns:${host}:5349?transport=tcp`,
      ];
    }

    // TURN без учётных данных бесполезен — добавляем только при наличии обоих
    if (turnUrls.length && credential) {
      iceServers.push({ urls: turnUrls, username, credential });
    }

    // Медиасервер поднимается отдельным профилем compose (`--profile sfu`) и
    // есть далеко не у всех: self-host без него обязан работать полностью на
    // p2p. Признак — заданные SFU_URL (куда идти клиенту) и SFU_SECRET (чем
    // подписан пропуск): без второго медиасервер никого не пустит.
    const sfu = { available: sfuConfigured() };

    return { iceServers, sfu };
  }
}
