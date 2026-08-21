import { Controller, Get } from '@nestjs/common';
import { retention, type RetentionMode } from './db/retention.service';
import { issueTurnCredentials, turnSecret } from './turn';
import { sfuHealthy } from './sfu/sfu-health';
import { serverVersion } from './version';

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
  async getConfig(): Promise<{
    iceServers: IceServer[];
    sfu: { available: boolean };
    retentionDays: number;
    retentionMode: RetentionMode;
    version: string;
    iceExpiresAt?: number;
  }> {
    const iceServers: IceServer[] = [];

    // Без TURN звонок не соберётся между «строгими» NAT (мобильные сети и т.п.)
    //
    // Два способа доказать ретранслятору, что мы свои. Временная пара (secret)
    // — основной: она подписана, живёт сутки и у каждого своя. Статическая —
    // то, что было до 1.0, и остаётся ровно для одного случая: TURN_URLS
    // смотрит на чужой сервер, у которого своя вечная пара и нашего секрета
    // нет. См. turn.ts.
    const secret = turnSecret();
    const staticCredential = process.env.TURN_CREDENTIAL ?? '';
    const staticUsername = process.env.TURN_USERNAME || 'webrtc';
    const host = process.env.SERVER_HOST;
    // Свой coturn поднят (профиль turn): у него есть секрет и публичный хост.
    const haveOwnTurn = !!(secret || staticCredential) && !!host && host !== 'localhost';

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

    // TURN без учётных данных бесполезен — добавляем только при наличии обоих.
    // Срок годности уезжает клиенту отдельным полем: без него вкладка не может
    // знать, что её пара скисла, и молча звонила бы мимо ретранслятора.
    let iceExpiresAt: number | undefined;
    if (turnUrls.length && secret) {
      const pass = issueTurnCredentials(secret);
      iceServers.push({
        urls: turnUrls,
        username: pass.username,
        credential: pass.credential,
      });
      iceExpiresAt = pass.expiresAt;
    } else if (turnUrls.length && staticCredential) {
      iceServers.push({
        urls: turnUrls,
        username: staticUsername,
        credential: staticCredential,
      });
    }

    // Медиасервер поднимается отдельным профилем compose (`--profile sfu`) и
    // есть далеко не у всех: self-host без него обязан работать полностью на
    // p2p. Признак — не только env (SFU_URL + SFU_SECRET), но и живой ответ на
    // health-пинг: лежащий контейнер не должен собирать звонки на себя.
    const sfu = { available: await sfuHealthy() };

    // Что будет с перепиской. Клиенту это нужно не для красоты: без срока он не
    // может объяснить человеку, куда делся верх ленты, и «начало канала»
    // выглядит одинаково с «дальше уже удалено».
    const policy = retention();
    return {
      iceServers,
      sfu,
      retentionDays: policy.mode === 'days' ? policy.days : 0,
      retentionMode: policy.mode,
      // Версия живёт здесь, а не в публичном `/api/health`: номер сборки
      // нужен тому, кто уже вошёл (свериться с клиентом), и не нужен
      // никому снаружи — раздавать его всем подряд незачем.
      version: serverVersion(),
      ...(iceExpiresAt ? { iceExpiresAt } : {}),
    };
  }
}
