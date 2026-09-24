# Этап B: присутствие и звонок один на один — план реализации

> **Для исполнителя:** ОБЯЗАТЕЛЬНЫЙ СУБ-НАВЫК: `superpowers:subagent-driven-development`
> (рекомендуется) или `superpowers:executing-plans` — задача за задачей. Шаги помечены
> чекбоксами (`- [ ]`).

**Цель:** позвонить человеку, а не зайти в комнату. У собеседника — входящий с «принять» и
«отклонить»; у звонящего — «дозваниваемся», отбой, «отклонён», «не ответили», «занято», «не в
сети»; в переписке — отметка о пропущенном с возможностью перезвонить.

**Архитектура:** три механики, которых в продукте нет ни одной.

1. **Глобальное присутствие личности** — «в сети / в голосе / недавно», на всю инсталляцию.
   Сегодняшнее `voice-presence` пер-канальное и для звонка не годится: оно отвечает на вопрос
   «кто в этой комнате», а нужен «где вообще этот человек».
2. **Вызов** — состояние между двумя людьми, живущее до ответа: `ringing → accepted |
   declined | no-answer | busy | cancelled`. Оно не принадлежит ни сокету (тот рвётся), ни
   комнате (её ещё нет), поэтому живёт отдельным владельцем в памяти гейтвея.
3. **Разговор** — уже существующий mesh: принятый вызов сажает двоих в голосовую комнату
   беседы. SFU для двоих не нужен никогда.

**Стек:** тот же, что в этапах A и C.

**Спека:** [docs/plans/relay-2.0.md](relay-2.0.md) (раздел «Дозвон»),
[reference/direct-messages/README.md](../../reference/direct-messages/README.md) (экраны 4–6,
кадры `2e`–`2g`).

**Предыдущие этапы:** [relay-2.0-dm.md](relay-2.0-dm.md) — пропущенный звонок рисуется в
переписке, значит переписка должна существовать. [relay-2.0-admin.md](relay-2.0-admin.md) —
параметры звонка (таймаут, кто кому может звонить) добавляются в каталог, а не заводят себе
второй способ настройки.

## Глобальные ограничения

- Всё то же, что в [этапе A](relay-2.0-dm.md#глобальные-ограничения).
- **Новые параметры — строкой в каталог** `packages/shared/src/settings.ts` (группа `calls`),
  а не константой в коде: этап C уже приучил инсталляцию к тому, что настраивается всё.
- **Входящий — не модалка.** По плану 2.0 вызов должно быть можно проигнорировать и
  продолжать пользоваться интерфейсом: на десктопе тост в углу, на мобиле баннер сверху.
- **Зелёный `ok` = «дозвон возможен»** (позвонить, принять, в сети), **красный `danger` =
  отбой, отклонён, пропущен.** Ничего декоративного этими цветами не красим.
- **Честное ограничение сказано в интерфейсе:** входящий дойдёт, только если открыт веб или
  запущено приложение; мобильный веб без пушей его не поймает. Строка стоит на экране
  исходящего вызова, а не в документации.
- **Проверяется живым прогоном между двумя машинами.** Юнит-тесты закрывают машину
  состояний и обработчики; «звонок собрался и его слышно» ими не доказывается.

---

## Карта файлов

**Создаются:** `packages/shared/src/ring.ts` (машина состояний + протокол),
`packages/shared/src/ring.test.ts`, `apps/api/src/gateway/presence.ts` (+ тест),
`apps/api/src/gateway/ring.ts` (+ тест), `apps/api/src/gateway/ring.handlers.ts` (+ тест),
`apps/web/stores/presence.ts` (+ тест), `apps/web/stores/ring.ts` (+ тест),
`apps/web/components/call/OutgoingCall.tsx`, `IncomingToast.tsx`, `MissedCallMark.tsx`,
`apps/web/lib/call.ts`, `e2e/tests/call.spec.ts`.

**Правятся:** `packages/shared/src/index.ts`, `packages/shared/src/settings.ts` (группа
`calls`), `apps/api/src/gateway/signaling.gateway.ts`, `voice-sessions.ts`, `perimeter.ts`,
`gateway.testkit.ts`, `apps/web/components/layout/Toolbar.tsx` (цель Call оживает),
`components/dm/DmThread.tsx`, `DmPeerCard.tsx`, `DmList.tsx` (точки присутствия),
`components/layout/Members.tsx`, `OnlineMembers.tsx`, `components/providers/SocketProvider.tsx`,
`lib/sfx.ts` (звонок), `lib/notify.ts`, `clients/desktop` (трей и нативное уведомление),
`lib/i18n/messages/*.json`, `docs/protocol.md`.

---

## Новые параметры каталога (группа `calls`)

| Ключ | Вид | Умолчание | Применение |
|---|---|---|---|
| `calls.enabled` | boolean | true | now |
| `calls.ringTimeoutSeconds` | number 10…180 | 45 | now |
| `calls.whoCanCall` | select `everyone` / `conversation` / `nobody` | conversation | now |
| `calls.videoAllowed` | boolean | true | now |
| `calls.missedMarkEnabled` | boolean | true | now |
| `calls.busyWhenInVoice` | boolean | true | now |
| `calls.maxRingsPerHour` | number 0…200 | 30 | now |

`whoCanCall: conversation` (умолчание) означает «звонить можно тому, с кем есть переписка» —
самое узкое из осмысленных правил, и оно естественно вытекает из этапа A.

Вместе с группой правится тест длины каталога в `packages/shared/src/settings.test.ts`:
`SETTINGS.length` становится **105**, а `SETTING_GROUPS` — тринадцать групп. Забыть об этом
нельзя: прогон упадёт на первой же задаче этапа.

---

### Задача 1: Глобальное присутствие — сервер

**Файлы:** создать `apps/api/src/gateway/presence.ts` (+ `presence.test.ts`); изменить
`signaling.gateway.ts`, `gateway.testkit.ts`, `packages/shared/src/index.ts`, `docs/protocol.md`.

**Интерфейсы:**

```ts
export type PresenceState = 'online' | 'in-voice' | 'recent' | 'offline';
export interface PresenceEntry { fingerprint: string; state: PresenceState; since: number }
class Presence {
  /** Сокет подключился/отключился — пересчитать личность и разослать изменение. */
  touch(identityId: string): void;
  drop(identityId: string): void;
  /** Снимок для этого сокета: только те, кого ему положено видеть. */
  snapshot(): PresenceEntry[];
  stateOf(identityId: string): PresenceState;
}
```

События: `presence` (снимок на подключении), `presence-update` (дельта). Рассылка
коалесцируется тем же окном 80 мс, что и реестр.

- [ ] **Шаг 1: Тест**

```ts
it('человек в сети, пока у него есть хоть один сокет', async () => { /* два устройства, отключаем одно */ });
it('ушедший становится «недавно», а не «офлайн» мгновенно', async () => { /* … */ });
it('вошедший в голосовой канал показывается «в голосе»', async () => { /* … */ });
it('дельта уходит один раз на пачку изменений', async () => { /* … */ });
it('гость по инвайту в присутствии не появляется', async () => { /* … */ });
```

- [ ] **Шаг 2: Прогнать — упасть.**
- [ ] **Шаг 3: Реализация.**
- [ ] **Шаг 4: Прогнать `src/gateway` — зелёные.**
- [ ] **Шаг 5: Коммит** — `feat(calls): global identity presence`

---

### Задача 2: Присутствие в вебе

**Файлы:** создать `apps/web/stores/presence.ts` (+ тест); изменить `SocketProvider.tsx`,
`DmList.tsx`, `DmPeerCard.tsx`, `DmThread.tsx`, `Members.tsx`, `OnlineMembers.tsx`,
`components/admin/PeopleTab.tsx`, `Toolbar.tsx` (стек лиц «кто в сети»).

- [ ] **Шаг 1: Тест** — снимок заполняет стор; дельта правит одного, не трогая остальных;
      «недавно» превращается в «офлайн» по времени; неизвестный человек — `offline`, а не
      пустота.
- [ ] **Шаг 2–4: упасть → реализовать → зелёные.**
- [ ] **Шаг 5: Точка присутствия — один компонент** на все места, где показан человек.
      Разные точки в разных местах — это разъезд, который никто не заметит до жалобы.
- [ ] **Шаг 6: Коммит** — `feat(calls): presence dots everywhere a person is shown`

---

### Задача 3: Машина состояний вызова

**Файлы:** создать `packages/shared/src/ring.ts` (+ `ring.test.ts`); изменить
`packages/shared/src/index.ts`.

**Почему отдельно и первой:** вызов — это гонки. Двое звонят друг другу одновременно; сокет
рвётся между вызовом и приёмом; «принять» приходит после таймаута; «отбой» — одновременно с
«принять». Всё это разбирается на чистой функции перехода, которую можно прогнать сотней
случаев, а не на живых сокетах.

**Интерфейсы:**

```ts
export type RingState = 'idle' | 'ringing' | 'accepted' | 'declined' | 'no-answer' | 'busy' | 'cancelled' | 'failed';
export type RingEvent =
  | { type: 'call'; at: number }
  | { type: 'accept'; at: number }
  | { type: 'decline'; at: number }
  | { type: 'cancel'; at: number }
  | { type: 'timeout'; at: number }
  | { type: 'busy'; at: number }
  | { type: 'peer-gone'; at: number };
export interface Ring { id: string; from: string; to: string; state: RingState; startedAt: number; endedAt?: number }
/** Переход. Возвращает то же состояние, если событие в нём не значит ничего. */
export function step(ring: Ring, event: RingEvent): Ring;
/** Конечное ли состояние: по нему решают, убирать ли вызов из памяти. */
export function settled(state: RingState): boolean;
/** Пропущенный ли это исход — то, что рисуется отметкой в переписке. */
export function missed(state: RingState): boolean;
```

- [ ] **Шаг 1: Тест**

```ts
it('вызов начинается со звонка и кончается принятием', () => { /* … */ });
it('после конечного состояния события ничего не меняют', () => {
  const declined = step(ringing, { type: 'decline', at: 2 });
  expect(step(declined, { type: 'accept', at: 3 })).toEqual(declined);
});
it('таймаут после принятия ничего не значит', () => { /* … */ });
it('отбой и принятие в одну миллисекунду дают один исход, а не оба', () => { /* … */ });
it('пропущенным считается «не ответили» и «не в сети», но не «отклонён»', () => {
  expect(missed('no-answer')).toBe(true);
  expect(missed('declined')).toBe(false);
});
it('обрыв у собеседника до ответа — «не в сети», после ответа — конец разговора', () => { /* … */ });
```

- [ ] **Шаг 2–4: упасть → реализовать → зелёные.**
- [ ] **Шаг 5: Коммит** — `feat(calls): the ring state machine, races included`

---

### Задача 4: Вызов на сервере

**Файлы:** создать `apps/api/src/gateway/ring.ts` (владелец живых вызовов) и
`ring.handlers.ts` (+ тесты); изменить `signaling.gateway.ts`, `gateway.testkit.ts`,
`packages/shared/src/settings.ts` (группа `calls`), `docs/protocol.md`.

**Протокол:** `call-start` (ack: `{ ok, ringId }` либо отказ `busy` / `offline` /
`forbidden` / `disabled` / `rate`), `call-accept`, `call-decline`, `call-cancel`;
сервер → клиент: `call-incoming`, `call-state`, `call-ended`.

- [ ] **Шаг 1: Тест**

```ts
it('звонок доходит до всех устройств собеседника', async () => { /* … */ });
it('принявшее устройство гасит входящий на остальных', async () => { /* … */ });
it('вызов не в сети отвечает offline и оставляет отметку о пропущенном', async () => { /* … */ });
it('вызов занятому отвечает busy', async () => { /* … */ });
it('таймаут закрывает вызов и обеим сторонам говорит «не ответили»', async () => { /* … */ });
it('обрыв сокета звонящего до ответа отменяет вызов', async () => { /* … */ });
it('двое, позвонившие друг другу одновременно, не остаются в двух вызовах', async () => { /* … */ });
it('whoCanCall=conversation не даёт позвонить тому, с кем нет переписки', async () => { /* … */ });
it('calls.enabled=false отвечает disabled', async () => { /* … */ });
it('лимит звонков в час срабатывает и не мешает принимать входящие', async () => { /* … */ });
```

- [ ] **Шаг 2–4: упасть → реализовать → зелёные (весь `src/gateway`).**
- [ ] **Шаг 5: Коммит** — `feat(calls): ring, accept, decline, timeout on the server`

---

### Задача 5: Принятый вызов становится разговором

**Файлы:** изменить `apps/api/src/gateway/voice-sessions.ts`, `ring.ts`, `perimeter.ts`,
`apps/web/lib/voice.ts`, `apps/web/lib/call.ts` (новый).

**Что делает:** принятый вызов сажает двоих в голосовую комнату беседы
(`voice:<адрес беседы>`), всегда mesh. Комната живёт, пока в ней двое; уход любого —
конец разговора.

- [ ] **Шаг 1: Тест** — вход в комнату происходит по принятию, а не по клику; третий в
      комнату беседы не входит; уход одного завершает разговор у второго; SFU для комнаты
      беседы не предлагается никогда.
- [ ] **Шаг 2–4: упасть → реализовать → зелёные.**
- [ ] **Шаг 5: Коммит** — `feat(calls): an accepted ring seats the two in a mesh room`

---

### Задача 6: Веб — исходящий вызов

**Файлы:** создать `apps/web/stores/ring.ts` (+ тест), `components/call/OutgoingCall.tsx`;
изменить `Toolbar.tsx` (цель Call), `DmPeerCard.tsx`, `DmThread.tsx`.

- [ ] **Шаг 1: Тест** — лицо 104px с кольцами; переключение подписи и цвета по состоянию
      (`ringing` / `declined` / `no answer` / `busy` / `offline`); отбой; «Write instead»
      уводит в переписку, не роняя вызов дважды; строка про доставку вызова видна.
- [ ] **Шаг 2–4: упасть → реализовать → зелёные.**
- [ ] **Шаг 5: Коммит** — `feat(calls): the outgoing call screen`

---

### Задача 7: Веб — входящий

**Файлы:** создать `components/call/IncomingToast.tsx`; изменить `AppShell.tsx`, `lib/sfx.ts`,
`lib/notify.ts`.

- [ ] **Шаг 1: Тест** — тост в углу, а не модалка: интерфейс под ним остаётся кликабельным;
      «принять» и «отклонить» ≥44px; звук идёт и останавливается вместе с вызовом; при
      свёрнутом окне уходит системное уведомление; второй входящий во время разговора
      отвечает «занято» сам.
- [ ] **Шаг 2–4: упасть → реализовать → зелёные.**
- [ ] **Шаг 5: Коммит** — `feat(calls): incoming call as a toast, not a takeover`

---

### Задача 8: Пропущенный в переписке

**Файлы:** создать `components/call/MissedCallMark.tsx`; изменить `DmThread.tsx`,
`apps/api/src/gateway/ring.ts` (запись отметки), `chat.service.ts` (системная строка особого
вида).

- [ ] **Шаг 1: Тест** — отметка отличима от сообщения (пунктирная плашка, не пузырь); несёт
      время и длительность дозвона; «call back» звонит тому же человеку; отклонённый вызов
      отметки не оставляет; отметка переживает перезагрузку и подчиняется ретенции.
- [ ] **Шаг 2–4: упасть → реализовать → зелёные.**
- [ ] **Шаг 5: Коммит** — `feat(calls): missed call marks in the conversation`

---

### Задача 9: Уведомления и честное ограничение

**Файлы:** изменить `apps/web/lib/notify.ts`, `clients/desktop` (трей, нативное
уведомление, окно поверх), `clients/desktop-linux`, `lib/i18n/messages/*.json`.

- [ ] **Шаг 1: Тест** — вкладка в фоне мигает заголовком и звучит; десктоп поднимает окно;
      строка «входящий придёт, только пока открыт веб или запущено приложение» стоит на
      экране исходящего и на мобиле; на мобильном вебе она сказана прямо, а не выясняется
      опытом.
- [ ] **Шаг 2–4: упасть → реализовать → зелёные.**
- [ ] **Шаг 5: Коммит** — `feat(calls): notifications and an honest delivery notice`

---

### Задача 10: e2e и живой прогон

**Файлы:** создать `e2e/tests/call.spec.ts`; изменить `docs/plans/relay-2.0.md`, `README*.md`.

- [ ] **Шаг 1: e2e** — два контекста: звонок принят и слышен (проверяется по состоянию
      `RTCPeerConnection`, а не по звуку); отклонён; не отвечен по таймауту; звонок в
      закрытую вкладку оставляет отметку.
- [ ] **Шаг 2: Прогнать — упасть → починить → зелёные.**
- [ ] **Шаг 3: Живой прогон между двумя машинами** — все ветви руками, включая мобильный
      веб (там входящий не придёт, и это ожидаемый исход, а не баг). Записать результат в
      `docs/plans/relay-2.0.md`.
- [ ] **Шаг 4: Полный гейт**

```bash
docker run --rm --network relay-dev_default -v "$PWD":/mono -w /mono -e TEST_DATABASE_URL=postgresql://relay:relay@db:5432/relay_test node:20-alpine sh -c 'corepack enable && pnpm install --frozen-lockfile && pnpm turbo run typecheck test build'
```

- [ ] **Шаг 5: Коммит** — `feat(calls): two-machine e2e and the live run`

---

## Готово, когда

- Живой звонок между двумя машинами прошёл по всем ветвям: принят, отклонён, не отвечен,
  занято, не в сети, отбой с каждой стороны.
- Входящий можно проигнорировать и продолжать работать.
- Пропущенный виден в переписке и с него можно перезвонить.
- Присутствие показано везде, где показан человек, — одной и той же точкой.
- Ограничение доставки сказано в интерфейсе.
- Решение по пуш-шлюзу принято и записано (этап 5 плана 2.0) — либо он есть, либо его нет и
  об этом сказано вслух.
