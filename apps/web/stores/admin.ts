import { create } from 'zustand';
import type {
  AdminAction,
  AdminActionResult,
  AdminBansResult,
  AdminChangedRelay,
  AdminOverview,
  AdminPasswordResult,
  AdminPeopleResult,
  AdminPerson,
  AdminResetResult,
  AdminSetResult,
  AdminStateResult,
  BanEntry,
  SettingGroup,
  SettingSpec,
  SettingValue,
  SettingsSnapshot,
} from '@relay/shared';
import { getSocket } from '@/lib/socket';
import { useOwnerStore } from '@/stores/owner';
import type { AdminFieldError } from '@/lib/refusals';

/**
 * Панель инсталляции глазами браузера: каталог, значения и то, что с ними
 * происходит прямо сейчас.
 *
 * Стор нужен не ради хранения снимка — его отдаёт одно событие, — а ради трёх
 * состояний, которых у поля не бывает в обычной форме. Поле панели живёт между
 * двумя ответами сервера: человек его тронул, значение уже показано, а принято
 * оно будет через сеть и может быть отвергнуто. Поэтому здесь есть `saving`
 * («ответа ещё нет»), `errors` («ответили отказом, и вот почему») и откат к
 * тому, что сервер подтвердил последним.
 *
 * Оптимистично — потому что иначе поле дёргается: переключатель, ждущий сети,
 * возвращается в прежнее положение на время ответа, и человек успевает нажать
 * его второй раз. Показываем сразу, а при отказе возвращаем прежнее и говорим
 * причину: молчаливый откат неотличим от «панель не работает».
 *
 * Прав стор не проверяет — их проверяет сервер на каждом событии (§9 протокола,
 * ограничение 10 плана): кнопка, которую клиент не нарисовал, ничего не
 * запрещает. Единственная уступка — не спрашивать состояние, когда владельца
 * заведомо нет: ответ известен заранее.
 */

/**
 * Сколько ждём ответа. У `socket.emit` с подтверждением своего срока нет вовсе,
 * и молчащий сервер оставил бы поле в «сохраняется» навсегда. Срок тот же, что
 * у списка переписок (stores/dm.ts), — цифра общая по смыслу, а не совпадение.
 */
const ACK_TIMEOUT_MS = 6000;

/** Ответ сервера либо наше собственное «он промолчал». */
type Answered<T extends { ok: boolean }> = T | { ok: false; error: 'timeout' };

/**
 * Спросить сервер и не ждать вечно. Все дороги панели — с ack, и у всех один и
 * тот же способ провала, поэтому срок живёт здесь, а не в каждой из них.
 */
function ack<T extends { ok: boolean }>(
  send: (cb: (res: T) => void) => void,
): Promise<Answered<T>> {
  return new Promise((resolve) => {
    let answered = false;
    const giveUp = setTimeout(() => {
      if (answered) return;
      answered = true;
      resolve({ ok: false, error: 'timeout' });
    }, ACK_TIMEOUT_MS);
    send((res) => {
      if (answered) return;
      answered = true;
      clearTimeout(giveUp);
      resolve(res);
    });
  });
}

/**
 * Номер последней правки по ключу. Правка, которую обогнала следующая, теряет
 * право на поле: её ответ не снимает пометку «сохраняется», поставленную второй,
 * и не откатывает значение, которое второй уже заменил. Без этого две правки
 * подряд оставляли бы поле либо в вечном «сохраняется» (ответ на первую снял
 * пометку, ответ на вторую поставил её снова), либо со значением первой.
 */
let seq = 0;
const pending = new Map<string, number>();

/**
 * Значения, подтверждённые сервером, — то, куда возвращается поле при отказе.
 * Отдельно от `values`, где живёт показанное человеку, и вне стора: рисовать по
 * ним нечего, а перерисовку они бы вызывали на каждый ответ.
 */
const confirmed = new Map<string, SettingValue>();

interface AdminState {
  /** Состояние панели приехало. До этого рисовать нечего — каталог с сервера. */
  loaded: boolean;
  /**
   * Каталог, каким его прислал СЕРВЕР, а не своя копия из `@relay/shared`:
   * параметры добавляются в любом выпуске, а версия контракта поднимается
   * только с мажором (§9.1). Панель, нарисованная по своей копии, показала бы
   * поля, которых сервер не знает.
   */
  catalog: SettingSpec[];
  /** Действующие значения. У секрета — признак «задано», значение не уезжает. */
  values: SettingsSnapshot;
  overview: AdminOverview | null;
  /** Ключи, чья запись сейчас в полёте: поле показывает это, а не «сохранено». */
  saving: string[];
  /** Отказ по ключу — подпись под полем. Хранится причиной, текст даёт i18n. */
  errors: Record<string, AdminFieldError>;
  /**
   * Отказ на всю панель: не отдали состояние, не приняли сброс группы. Своё
   * поле, а не запись в `errors`, потому что показывать его негде под полем —
   * полей в этот момент может не быть вовсе.
   */
  error: AdminFieldError | null;

  /**
   * Страница людей — то, что показывает вкладка личностей.
   *
   * Список живёт в сторе, а не во вкладке, ровно ради одного обещания: бан,
   * поставленный на одной вкладке, виден на другой в тот же миг. Держи его
   * каждая вкладка у себя — снятый бан вернул бы человека в общий список
   * только после того, как панель закроют и откроют заново.
   */
  people: AdminPerson[];
  /** Ключ следующей страницы. `null` — ниже ничего нет. */
  peopleCursor: string | null;
  /** Поиск, которым набран текущий список: ответ на устаревший не берём. */
  peopleQuery: string;
  /** Спрашиваем страницу прямо сейчас. */
  peopleBusy: boolean;
  /** Хоть раз спросили: пустой список без этого неотличим от «ещё не грузили». */
  peopleLoaded: boolean;
  bans: BanEntry[];
  bansBusy: boolean;
  bansLoaded: boolean;
  /**
   * Отказ на список целиком (людей не отдали, баны не отдали). Отдельно от
   * `error`, который гасит всю панель: список — одна её вкладка, и молчать о
   * нём поверх работающих настроек было бы враньём в обе стороны.
   */
  listError: AdminFieldError | null;

  load: () => Promise<void>;
  set: (key: string, value: SettingValue, opts?: { confirm?: boolean }) => Promise<void>;
  /** Правка из другой сессии владельца (`admin-changed`, §9.6). */
  applyRemote: (relay: AdminChangedRelay) => void;
  resetGroup: (group: SettingGroup) => Promise<void>;
  /** Пароль инсталляции — своей дорогой (§9.5), не через `set`. */
  setPassword: (password: string) => Promise<void>;

  /** Первая страница людей: пустой запрос — просто список. */
  loadPeople: (query?: string) => Promise<void>;
  /** Следующая страница по курсору. Без курсора не делает ничего. */
  morePeople: () => Promise<void>;
  loadBans: () => Promise<void>;
  /**
   * Бан, разбан и отзыв чужого устройства.
   *
   * Возвращают причину отказа, а не кладут её в стор: отказ здесь относится к
   * одной строке списка («такого отпечатка нет», «это твоё устройство»), и
   * показывать его надо рядом с ней, а не общей полосой над всей вкладкой.
   * `null` — получилось.
   */
  ban: (fingerprint: string) => Promise<AdminFieldError | null>;
  unban: (fingerprint: string) => Promise<AdminFieldError | null>;
  revokeDevice: (deviceId: string) => Promise<AdminFieldError | null>;

  reset: () => void;
}

const initial: Pick<
  AdminState,
  | 'loaded'
  | 'catalog'
  | 'values'
  | 'overview'
  | 'saving'
  | 'errors'
  | 'error'
  | 'people'
  | 'peopleCursor'
  | 'peopleQuery'
  | 'peopleBusy'
  | 'peopleLoaded'
  | 'bans'
  | 'bansBusy'
  | 'bansLoaded'
  | 'listError'
> = {
  loaded: false,
  catalog: [],
  values: {},
  overview: null,
  saving: [],
  errors: {},
  error: null,
  people: [],
  peopleCursor: null,
  peopleQuery: '',
  peopleBusy: false,
  peopleLoaded: false,
  bans: [],
  bansBusy: false,
  bansLoaded: false,
  listError: null,
};

/** Тот же набор без одного ключа — отказ снимается, когда поле трогают заново. */
function without(errors: Record<string, AdminFieldError>, key: string) {
  if (!(key in errors)) return errors;
  const rest = { ...errors };
  delete rest[key];
  return rest;
}

// zustand-сеттер назван `patch`: имя `set` в этом сторе занято правкой параметра.
export const useAdminStore = create<AdminState>((patch, get) => ({
  ...initial,

  load: async () => {
    // Владельца нет — не спрашиваем: ответ известен заранее (`forbidden` на
    // каждом событии панели). Это не проверка прав, а отказ от заведомо пустого
    // запроса; права проверяет сервер, и только он.
    if (!useOwnerStore.getState().owner) {
      patch({ error: 'forbidden' });
      return;
    }
    const res = await ack<AdminStateResult>((cb) => getSocket().emit('admin-state', cb));
    if (!res.ok) {
      patch({ error: res.error });
      return;
    }
    confirmed.clear();
    for (const [key, value] of Object.entries(res.values)) confirmed.set(key, value);
    // Правки, начатые до открытия панели, теряют право на поле: их пометки
    // сняты, и ответ на них уже ничего не тронет (см. `pending`). Иначе ключ,
    // ответа по которому не дождались, остался бы в «сохраняется» поверх
    // свежего снимка.
    pending.clear();
    patch({
      loaded: true,
      catalog: res.catalog,
      values: { ...res.values },
      overview: res.overview,
      saving: [],
      errors: {},
      error: null,
    });
  },

  set: async (key, value, opts) => {
    // Секрет общей дорогой не пишется (§9.5): у пароля инсталляции своя, и
    // отправить его сюда значит отправить его мимо той, что отзывает пропуска.
    // Сервер ответил бы тем же `secret-path`, но пароль при этом успел бы
    // уехать в запись, которой он не предназначен.
    if (get().catalog.find((spec) => spec.key === key)?.secret) {
      patch((s) => ({ errors: { ...s.errors, [key]: 'secret-path' } }));
      return;
    }

    const mine = (seq += 1);
    pending.set(key, mine);
    patch((s) => ({
      // Значение показываем сразу — ради этого стор и оптимистичен.
      values: { ...s.values, [key]: value },
      saving: s.saving.includes(key) ? s.saving : [...s.saving, key],
      errors: without(s.errors, key),
    }));

    const res = await ack<AdminSetResult>((cb) =>
      // `confirm` кладём, только когда его просили: посылать «нет» там, где
      // ничего не спрашивали, — способ однажды послать «да» опечаткой.
      getSocket().emit(
        'admin-set',
        opts?.confirm ? { key, value, confirm: true } : { key, value },
        cb,
      ),
    );

    // Нас обогнала следующая правка того же поля — этот ответ уже ни о чём:
    // ни пометка, ни значение теперь не наши.
    if (pending.get(key) !== mine) return;
    pending.delete(key);

    if (res.ok) {
      confirmed.set(key, res.value);
      patch((s) => ({
        // Значение берём из ответа, а не своё: сервер мог принять его иначе
        // (`changed: false` — оно уже было таким).
        values: { ...s.values, [key]: res.value },
        saving: s.saving.filter((k) => k !== key),
        errors: without(s.errors, key),
      }));
      return;
    }

    patch((s) => ({
      // Откат к последнему подтверждённому. Подтверждённого нет только у
      // ключа, которого не было в снимке, — там возвращать нечего, и поле
      // остаётся как есть при видимой причине отказа.
      values: confirmed.has(key) ? { ...s.values, [key]: confirmed.get(key)! } : s.values,
      saving: s.saving.filter((k) => k !== key),
      errors: { ...s.errors, [key]: res.error },
    }));
  },

  applyRemote: (relay) => {
    const incoming = relay?.values;
    if (!incoming || typeof incoming !== 'object') return;
    patch((s) => {
      const values = { ...s.values };
      for (const [key, value] of Object.entries(incoming)) {
        confirmed.set(key, value);
        // Поле, чья правка сейчас в полёте, чужой не трогаем: своя правка
        // новее, и окончательное значение поставит ответ на неё. Откатывать
        // при этом всё равно будет куда — `confirmed` обновился.
        if (pending.has(key)) continue;
        values[key] = value;
      }
      return { values };
    });
  },

  resetGroup: async (group) => {
    // Подтверждение здесь всегда (§9.2): сброс — правка десятка полей одним
    // нажатием, и человек, сбрасывавший внешний вид, не должен заодно молча
    // узнать, что вернул срок хранения. Диалог рисует панель, а поле в запросе
    // — то, чем за это отвечают перед сервером.
    const res = await ack<AdminResetResult>((cb) =>
      getSocket().emit('admin-reset', { group, confirm: true }, cb),
    );
    if (!res.ok) {
      patch({ error: res.error });
      return;
    }
    for (const [key, value] of Object.entries(res.values)) confirmed.set(key, value);
    patch((s) => {
      const errors = { ...s.errors };
      for (const key of Object.keys(res.values)) delete errors[key];
      return { values: { ...s.values, ...res.values }, errors, error: null };
    });
  },

  setPassword: async (password) => {
    const res = await ack<AdminPasswordResult>((cb) =>
      getSocket().emit('admin-password', { password, confirm: true }, cb),
    );
    const key = passwordKey(get().catalog);
    if (!res.ok) {
      if (key) patch((s) => ({ errors: { ...s.errors, [key]: res.error } }));
      else patch({ error: res.error });
      return;
    }
    if (!key) return;
    // «Задано» знает только сервер: у секрета уезжает признак, а не значение.
    confirmed.set(key, res.set);
    patch((s) => ({ values: { ...s.values, [key]: res.set }, errors: without(s.errors, key) }));
  },

  loadPeople: async (query) => {
    const asked = query ?? get().peopleQuery;
    patch({ peopleQuery: asked, peopleBusy: true, listError: null });
    const res = await ack<AdminPeopleResult>((cb) =>
      // Поиск серверный: людей может быть тысяча, и выбирать нужного из
      // привезённой тысячи — это привезти тысячу.
      getSocket().emit('admin-people', asked ? { query: asked } : {}, cb),
    );
    // Пока летел ответ, человек дописал запрос. Страница по «ма» поверх
    // страницы по «маша» выглядит как поиск, который врёт через раз.
    if (get().peopleQuery !== asked) return;
    if (!res.ok) {
      patch({ peopleBusy: false, listError: res.error });
      return;
    }
    patch({
      people: res.people,
      peopleCursor: res.cursor ?? null,
      peopleBusy: false,
      peopleLoaded: true,
    });
  },

  morePeople: async () => {
    const { peopleCursor: cursor, peopleQuery: asked, peopleBusy } = get();
    // Курсор приходит, только если ниже что-то осталось (§9.3): его отсутствие
    // и есть конец списка, а не повод спросить ещё раз.
    if (!cursor || peopleBusy) return;
    patch({ peopleBusy: true, listError: null });
    const res = await ack<AdminPeopleResult>((cb) =>
      getSocket().emit('admin-people', asked ? { query: asked, cursor } : { cursor }, cb),
    );
    if (get().peopleQuery !== asked) return;
    if (!res.ok) {
      patch({ peopleBusy: false, listError: res.error });
      return;
    }
    patch((s) => ({
      people: [...s.people, ...res.people],
      peopleCursor: res.cursor ?? null,
      peopleBusy: false,
    }));
  },

  loadBans: async () => {
    patch({ bansBusy: true, listError: null });
    const res = await ack<AdminBansResult>((cb) => getSocket().emit('admin-bans', cb));
    if (!res.ok) {
      patch({ bansBusy: false, listError: res.error });
      return;
    }
    patch({ bans: res.bans, bansBusy: false, bansLoaded: true });
  },

  ban: async (fingerprint) => {
    const res = await act('ban', fingerprint);
    if (!res.ok) return res.error;
    patch((s) => ({
      people: s.people.map((p) => (p.fingerprint === fingerprint ? { ...p, banned: true } : p)),
      // Строку бана — когда и кем — пишет сервер, и сочинить её здесь значило бы
      // показать на соседней вкладке не то, что лежит в базе. Помечаем список
      // несвежим: вкладка банов спросит его, когда её откроют.
      bansLoaded: false,
      listError: null,
    }));
    return null;
  },

  unban: async (fingerprint) => {
    const res = await act('unban', fingerprint);
    if (!res.ok) return res.error;
    // А вот разбан известен целиком: строка бана исчезает, человек перестаёт
    // быть забаненным. Перечитывать за этим нечего, и человек возвращается в
    // общий список сразу — панель для этого не закрывают и не открывают заново.
    patch((s) => ({
      people: s.people.map((p) => (p.fingerprint === fingerprint ? { ...p, banned: false } : p)),
      bans: s.bans.filter((entry) => entry.fingerprint !== fingerprint),
      listError: null,
    }));
    return null;
  },

  revokeDevice: async (deviceId) => {
    const res = await act('revoke-device', deviceId);
    if (!res.ok) return res.error;
    // Id устройства уникален на всю инсталляцию, поэтому ищем его по всем
    // показанным людям, а не спрашиваем, у кого он был.
    patch((s) => ({
      people: s.people.map((person) => {
        if (!person.devices.some((d) => d.id === deviceId)) return person;
        return {
          ...person,
          devices: person.devices.map((d) => (d.id === deviceId ? { ...d, revoked: true } : d)),
        };
      }),
    }));
    return null;
  },

  reset: () => {
    pending.clear();
    confirmed.clear();
    patch({ ...initial });
  },
}));

/**
 * Действие панели с подтверждением.
 *
 * `confirm: true` уезжает всегда, потому что подтверждения просят все действия,
 * кроме выгрузки (§9.4), а спрашивать человека или нет — решает экран: бан
 * останавливают вопросом, разбан обратим и вопросом не останавливают. Поле в
 * запросе — то, чем за этот выбор отвечают перед сервером; доверять тому, что
 * панель показала диалог, сервер не станет и не должен.
 */
function act(action: AdminAction, target: string): Promise<Answered<AdminActionResult>> {
  return ack<AdminActionResult>((cb) =>
    getSocket().emit('admin-action', { action, target, confirm: true }, cb),
  );
}

/**
 * Ключ пароля инсталляции — по каталогу, а не по имени.
 *
 * Секретов в каталоге три, но два живут в окружении и в панели только
 * показываются; сменить можно ровно один, и он же единственный, у кого своя
 * дорога (§9.5). Вписать сюда имя строкой значило бы завести вторую копию
 * контракта, которая однажды разъедется с серверной.
 */
function passwordKey(catalog: SettingSpec[]): string | undefined {
  return catalog.find((spec) => spec.secret && !spec.readOnly)?.key;
}
