import type { AppSocket } from './socket-data';
import type { DmService } from './dm.service';
import type { Perimeter } from './perimeter';
import type { Rings } from './ring';
import type { SettingsService } from '../settings/settings.service';
import {
  LIMIT,
  trimmed,
  type CallReplyResult,
  type CallRingPayload,
  type CallStartPayload,
  type CallStartResult,
} from './protocol';

/**
 * Четыре события дозвона: позвонить, принять, отклонить, дать отбой.
 *
 * Состояния здесь нет вовсе — оно в `Rings`, и это единственная причина, по
 * которой файл читается за один присест. Кроме одного: счёта исходящих за час.
 * Он живёт здесь, а не у владельца вызовов, ровно потому, что вызовом не
 * является — это правило дома о том, кому позволено набирать, и стоит оно
 * рядом с остальными такими же правилами (кто кому может звонить, включён ли
 * дозвон вообще).
 *
 * Разделение труда с владельцем простое: сюда — «можно ли», туда — «что при
 * этом произойдёт с вызовом». Поэтому четыре из пяти отказов `call-start`
 * выдаются здесь, а `busy` — там: только владелец знает, кто сейчас в вызове,
 * и знать это должен он один.
 */
export class RingHandlers {
  /**
   * Кто и когда звонил — скользящим часом, в памяти процесса.
   *
   * Ровно тот же приём, что у счёта первых сообщений незнакомцу
   * (`DmHandlers.started`), и одинаковыми они сделаны нарочно: две почасовые
   * квоты, устроенные по-разному, читались бы дважды. Рестарт api прощает всех,
   * и это честно — серьёзный запрет живёт в `calls.whoCanCall`, а не здесь.
   */
  private readonly dialled = new Map<string, number[]>();

  constructor(
    private readonly rings: Rings,
    private readonly dm: DmService,
    private readonly perimeter: Perimeter,
    private readonly settings: SettingsService,
  ) {}

  /**
   * Кто вправе пользоваться дозвоном. Полноценная личность, и только она: у
   * гостя по инвайту личность живёт внутри одного приглашения — звонить ему
   * некуда, и звонить ему самому некому.
   */
  private me(client: AppSocket): string | undefined {
    if (!this.perimeter.allow(client) || this.perimeter.isGuest(client)) return undefined;
    return this.perimeter.speaker(client)?.id;
  }

  /**
   * Позвонить. Порядок проверок не косметический: сначала правила дома
   * (выключено, кому можно), потом достижимость, и только последним — почасовой
   * предел. Предел стоит последним, потому что тратится он лишь на
   * СОСТОЯВШИЙСЯ вызов: отказ выше не должен съедать час у человека, который
   * набрал того, кого нет на связи.
   */
  start(client: AppSocket, payload: CallStartPayload): CallStartResult {
    const speaker = this.perimeter.speaker(client);
    if (!this.me(client) || !speaker) return { ok: false, error: 'forbidden' };
    if (!this.settings.get<boolean>('calls.enabled')) return { ok: false, error: 'disabled' };
    const fingerprint = trimmed(payload?.fingerprint, LIMIT.fingerprint);
    // Себе не звонят. Отвечаем «нельзя», а не «занято»: занятости тут нет
    // никакой, а объяснение обязано совпадать с тем, что случилось.
    if (!fingerprint || fingerprint === speaker.fingerprint) {
      return { ok: false, error: 'forbidden' };
    }
    const peer = this.rings.whoIs(fingerprint);
    // Некого набирать: ни одного живого устройства. Это не исход вызова, а
    // отказ до него — самого вызова ещё нет (см. `CallRefusal`).
    if (!peer) return { ok: false, error: 'offline' };
    if (!this.mayCall(speaker.id, peer.id)) return { ok: false, error: 'forbidden' };
    if (!this.withinHourlyQuota(speaker.id)) return { ok: false, error: 'rate' };
    // Видео зажимается, а не отвергается: инсталляция без камер превращает
    // видеозвонок в голосовой, а не оставляет человека без звонка вовсе.
    const video =
      payload?.video === true && this.settings.get<boolean>('calls.videoAllowed') === true;
    const res = this.rings.start(speaker, peer, video);
    // Час тратится по факту начатого дозвона, а не по попытке: набор занятому
    // или самому себе не должен приближать человека к пределу.
    if (res.ok) this.dialled.set(speaker.id, [...(this.dialled.get(speaker.id) ?? []), Date.now()]);
    return res;
  }

  /**
   * Принять входящий.
   *
   * Почасовой предел здесь не спрашивается и спрашиваться не может: он считает
   * ИСХОДЯЩИЕ. Исчерпавший его человек остаётся доступен — иначе предел на
   * назойливость превращался бы в отключение от связи, причём для того, кто
   * назойлив не был.
   */
  accept(client: AppSocket, payload: CallRingPayload): CallReplyResult {
    return this.press(client, payload, (meId, ringId) => this.rings.accept(meId, ringId));
  }

  decline(client: AppSocket, payload: CallRingPayload): CallReplyResult {
    return this.press(client, payload, (meId, ringId) => this.rings.decline(meId, ringId));
  }

  cancel(client: AppSocket, payload: CallRingPayload): CallReplyResult {
    return this.press(client, payload, (meId, ringId) => this.rings.cancel(meId, ringId));
  }

  /**
   * Общая половина трёх кнопок: разобрать тело и назвать нажавшего.
   *
   * Выключенный дозвон (`calls.enabled`) здесь НЕ спрашивается. Выключатель
   * закрывает дверь новым вызовам, а уже звонящий доживает своё: оборвать его
   * молча значило бы оставить обоих смотреть на экран, который больше ничем не
   * кончится.
   */
  private press(
    client: AppSocket,
    payload: CallRingPayload,
    act: (meId: string, ringId: string) => CallReplyResult,
  ): CallReplyResult {
    const meId = this.me(client);
    const ringId = trimmed(payload?.ringId, LIMIT.id);
    if (!meId || !ringId) return { ok: false, error: 'unknown' };
    return act(meId, ringId);
  }

  /**
   * Кому этот человек вправе звонить.
   *
   * `conversation` — это ЗАВЕДЁННАЯ беседа, а не «виделись в одном канале»
   * (`DmService.seenTogether`, правило первого сообщения). Спутать их значило
   * бы разрешить звонок любому, кто когда-либо написал в общий канал, — то
   * есть всей инсталляции.
   */
  private mayCall(meId: string, peerId: string): boolean {
    const who = this.settings.get<string>('calls.whoCanCall');
    if (who === 'nobody') return false;
    if (who === 'conversation') return this.dm.hasConversation(meId, peerId);
    return true;
  }

  /**
   * Не слишком ли много набрано за последний час. Окно скользящее, а не «час с
   * полуночи»: набрав тридцать раз в 12:59, к 13:01 можно было бы набрать ещё
   * тридцать.
   */
  private withinHourlyQuota(meId: string): boolean {
    const perHour = this.settings.get<number>('calls.maxRingsPerHour');
    // Ноль — без предела (см. каталог): «совсем нельзя звонить» говорит
    // `calls.whoCanCall`, и двух способов сказать одно и то же не нужно.
    if (perHour <= 0) return true;
    const since = Date.now() - 60 * 60_000;
    const mine = (this.dialled.get(meId) ?? []).filter((ts) => ts > since);
    // Подчищаем на месте: карта живёт всю жизнь процесса, а заводить таймер
    // ради десятка записей незачем (см. тот же приём в `DmHandlers`).
    if (mine.length) this.dialled.set(meId, mine);
    else this.dialled.delete(meId);
    return mine.length < perHour;
  }
}
