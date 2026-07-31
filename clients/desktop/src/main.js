// Экран выбора сервера. Запоминает адреса инсталляций и уводит webview на web-UI
// relay — дальше весь UI (логин, чат, звонки) приходит из apps/web, десктоп его
// не форкает. Нативные фичи (трей, хоткеи) живут в Rust (src-tauri/src/main.rs).
//
// При старте клиент сам возвращается на последний сервер: пикер — это дорога,
// а не пункт назначения. Автопереход отменяем двумя способами:
//   • фрагмент `#pick` в URL — так пикер открывает пункт трея «Сменить сервер…»
//     (без этого экран уходил бы обратно на сервер, и адрес было бы не сменить);
//   • кнопка «Отмена» / Esc, пока идёт проверка доступности.

const KEY = 'relay-desktop-server'; // последний сервер (ключ от 0.3.x, не менять)
const KEY_LIST = 'relay-desktop-servers'; // недавние, свежий первым
const MAX_RECENT = 5;
const PROBE_MS = 10000;
// Адрес, которым ПРЕДЗАПОЛНЯЕТСЯ пустое поле: чтобы проверять сборки без
// ручного ввода. Автоперехода это не касается — он идёт только на сервер, к
// которому уже подключались (см. lastServer), так что свежая установка никуда
// сама не уйдёт, а адрес в поле человек всегда может стереть.
const DEFAULT_SERVER = 'https://overhype.tech';

const form = document.getElementById('form');
const input = document.getElementById('url');
const err = document.getElementById('err');
const btn = document.getElementById('go');
const skip = document.getElementById('skip');
const hint = document.getElementById('hint');
const auto = document.getElementById('auto');
const autoOrigin = document.getElementById('auto-origin');
const autoCancel = document.getElementById('auto-cancel');
const recentWrap = document.getElementById('recent-wrap');
const recentList = document.getElementById('recent');
const card = document.getElementById('card');
const logo = document.getElementById('logo');

// ── Язык ────────────────────────────────────────────────────────────────────
//
// Правила те же, что у web-UI (apps/web/lib/i18n): английский — база, остальные
// языки к нему откатываются по ключу. Отличие одно: куки web-UI здесь нет (её
// ставит уже сам сервер, на который мы уходим), поэтому язык берём из движка —
// navigator.languages, сравнение по первичному субтегу, чтобы ru-RU, ru-BY и ru
// одинаково попали в ru. Новый язык = ещё один блок в STRINGS, кода не трогать.

const STRINGS = {
  en: {
    'hint.pick': 'Address of your installation',
    'hint.auto': 'Returning to your server',
    'field.server': 'Server',
    'action.connect': 'Connect',
    'action.cancel': 'Cancel',
    'status.checking': 'Checking availability…',
    'action.goAnyway': 'Go anyway',
    'recent.title': 'Recent',
    'recent.last': 'last',
    'recent.remove': 'Remove from list',
    'recent.removeAria': 'Remove {origin} from list',
    'error.invalidAddress': 'Enter an address like https://relay.example.com',
    'error.unreachable': 'Server unavailable. Check the address and your network.',
    'error.timeout': 'The server did not answer in time. Check the address and your network.',
    'webrtc.title': 'Calls will not work in this build',
    'webrtc.body':
      'The system WebKitGTK engine is built without WebRTC support — that is a limit of the ' +
      'engine, not of relay. Chat and everything else work. For voice, open relay in Chromium, ' +
      'Firefox or Chrome.',
    'menu.cut': 'Cut',
    'menu.copy': 'Copy',
    'menu.paste': 'Paste',
    'menu.selectAll': 'Select all',
    'menu.copyAddress': 'Copy address',
    'menu.removeFromList': 'Remove from list',
    'clipboard.copyBlocked': 'The engine blocks copying from the menu — use the keyboard ({key}).',
    'clipboard.pasteBlocked': 'The engine blocks pasting from the menu — use the keyboard ({key}).',
  },
  ru: {
    'hint.pick': 'Адрес вашей инсталляции',
    'hint.auto': 'Возвращаемся на ваш сервер',
    'field.server': 'Сервер',
    'action.connect': 'Подключиться',
    'action.cancel': 'Отмена',
    'status.checking': 'Проверяю доступность…',
    'action.goAnyway': 'Перейти всё равно',
    'recent.title': 'Недавние',
    'recent.last': 'последний',
    'recent.remove': 'Убрать из списка',
    'recent.removeAria': 'Убрать {origin} из списка',
    'error.invalidAddress': 'Введите адрес вида https://relay.example.com',
    'error.unreachable': 'Сервер недоступен. Проверьте адрес и сеть.',
    'error.timeout': 'Сервер не ответил вовремя. Проверьте адрес и сеть.',
    'webrtc.title': 'Звонки в этой сборке работать не будут',
    'webrtc.body':
      'Системный движок WebKitGTK собран без поддержки WebRTC — это ограничение движка, а не ' +
      'relay. Чат и всё остальное работают. Для голоса откройте relay в Chromium, Firefox или ' +
      'Chrome.',
    'menu.cut': 'Вырезать',
    'menu.copy': 'Копировать',
    'menu.paste': 'Вставить',
    'menu.selectAll': 'Выделить всё',
    'menu.copyAddress': 'Копировать адрес',
    'menu.removeFromList': 'Убрать из списка',
    'clipboard.copyBlocked':
      'Движок не даёт скопировать через меню — сработает с клавиатуры ({key}).',
    'clipboard.pasteBlocked':
      'Движок не даёт вставить через меню — сработает с клавиатуры ({key}).',
  },
};

const DEFAULT_LOCALE = 'en';

/** Первый поддерживаемый язык движка; неизвестный — на базовый. */
function detectLocale() {
  const tags = navigator.languages?.length ? navigator.languages : [navigator.language || ''];
  for (const tag of tags) {
    const primary = String(tag).trim().toLowerCase().split('-')[0];
    if (primary in STRINGS) return primary;
  }
  return DEFAULT_LOCALE;
}

const locale = detectLocale();
document.documentElement.lang = locale;

/** `t('recent.removeAria', { origin })`. Нет ключа в языке — берём из базы. */
function t(key, vars) {
  const template = STRINGS[locale]?.[key] ?? STRINGS[DEFAULT_LOCALE][key] ?? key;
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (whole, name) =>
    name in vars ? String(vars[name]) : whole,
  );
}

/** Разовая заливка статических подписей разметки (data-i18n на элементе). */
function applyStaticStrings() {
  for (const el of document.querySelectorAll('[data-i18n]')) {
    el.textContent = t(el.dataset.i18n);
  }
}

applyStaticStrings();

// ── Знак ────────────────────────────────────────────────────────────────────

// Знак здесь работает индикатором состояния, а не заставкой: экран живёт
// секунды, и случайная анимация из четырёх (как variant="random" в web-UI)
// успевала бы показать половину непонятно чего. Поэтому вариант привязан к
// тому, что сейчас происходит:
//   покой      — draw/pulse (случайно из двух, чтобы не примелькалось)
//   проверка   — onair: узел пускает пинги, «стучимся на сервер»
//   сервер жив — handshake: рёбра схватываются; играет, пока грузится web-UI,
//                поэтому анимация ничего не задерживает.
const IDLE_VARIANTS = ['draw', 'pulse'];
const idleVariant = IDLE_VARIANTS[Math.floor(Math.random() * IDLE_VARIANTS.length)];

/** Состояние знака: 'idle' | 'probing' | 'connected'. */
function setLogo(state) {
  logo.dataset.v =
    state === 'probing' ? 'onair' : state === 'connected' ? 'handshake' : idleVariant;
}

setLogo('idle');

/**
 * Показать ошибку: текст + встряска карточки (как на /login в web-UI).
 * `detail` — техническая причина от движка («Failed to fetch», «Load failed»).
 * Она нужна для разбора полётов, но в середине русской фразы читается как
 * недоделка, поэтому идёт отдельной приглушённой строкой под сообщением.
 */
function showError(message, { shake = true, detail = '' } = {}) {
  err.classList.remove('busy');
  err.replaceChildren(document.createTextNode(message));
  if (detail) {
    const el = document.createElement('span');
    el.className = 'msg-detail';
    el.textContent = detail;
    err.append(el);
  }
  if (!message || !shake) return;
  card.classList.remove('shake');
  void card.offsetWidth; // перезапуск анимации на повторной ошибке
  card.classList.add('shake');
}

/** То же поле, но нейтральным тоном: «проверяю…» — не ошибка. */
function setStatus(message) {
  err.classList.toggle('busy', Boolean(message));
  err.textContent = message;
}

// ── Хранилище адресов ───────────────────────────────────────────────────────
// Приватный режим/квота могут бросить на любом обращении к localStorage —
// клиент от этого падать не должен, просто не запомнит адрес.

function readLS(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeLS(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* не запомнили — переживём */
  }
}

/** Последний сервер: сюда уходит автопереход. */
function lastServer() {
  const raw = readLS(KEY);
  return raw ? normalize(raw) : null;
}

/** Недавние адреса, свежий первым. Мусор из хранилища отсеиваем нормализацией. */
function recentServers() {
  let list = [];
  try {
    const parsed = JSON.parse(readLS(KEY_LIST) || '[]');
    if (Array.isArray(parsed)) list = parsed;
  } catch {
    /* битый JSON — начнём список заново */
  }
  const seen = new Set();
  const out = [];
  // Последний сервер мог прийти от версии без списка — не теряем его.
  for (const raw of [readLS(KEY), ...list]) {
    const origin = typeof raw === 'string' ? normalize(raw) : null;
    if (origin && !seen.has(origin)) {
      seen.add(origin);
      out.push(origin);
    }
  }
  return out.slice(0, MAX_RECENT);
}

/** Запомнить адрес как последний и поднять его в начало недавних. */
function remember(origin) {
  const list = [origin, ...recentServers().filter((o) => o !== origin)].slice(0, MAX_RECENT);
  writeLS(KEY, origin);
  writeLS(KEY_LIST, JSON.stringify(list));
}

/** Убрать адрес из недавних. Если он же был последним — снимаем автопереход. */
function forget(origin) {
  writeLS(KEY_LIST, JSON.stringify(recentServers().filter((o) => o !== origin)));
  if (readLS(KEY) && normalize(readLS(KEY)) === origin) writeLS(KEY, '');
  renderRecent();
}

function renderRecent() {
  const list = recentServers();
  const last = lastServer();
  recentList.replaceChildren();
  for (const origin of list) {
    const li = document.createElement('li');

    const go = document.createElement('button');
    go.type = 'button';
    go.className = 'recent-go';
    go.title = origin;
    // Адрес разбираем на схему и хост: схема одинакова у всех строк и глазу не
    // нужна, а различает их хост — его и подаём на переднем плане.
    const addr = document.createElement('span');
    addr.className = 'recent-addr';
    const scheme = document.createElement('span');
    scheme.className = 'recent-scheme';
    scheme.textContent = `${origin.slice(0, origin.indexOf('//') + 2)}`;
    const host = document.createElement('span');
    host.className = 'recent-host';
    host.textContent = origin.slice(origin.indexOf('//') + 2);
    addr.append(scheme, host);
    go.append(addr);
    // Адрес, на который клиент уйдёт сам при следующем запуске. Без пометки
    // автопереход ничем не объяснён: «почему он опять там?».
    if (origin === last) {
      const badge = document.createElement('span');
      badge.className = 'recent-badge';
      badge.textContent = t('recent.last');
      go.append(badge);
    }
    // textContent строки собирается из нескольких span-ов (и может нести
    // пометку) — адрес для меню и обработчиков берём отсюда, а не из текста.
    go.dataset.origin = origin;
    go.addEventListener('click', () => {
      input.value = origin;
      attempt(origin);
    });

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'recent-del';
    del.textContent = '×';
    del.title = t('recent.remove');
    del.setAttribute('aria-label', t('recent.removeAria', { origin }));
    del.addEventListener('click', () => forget(origin));

    li.append(go, del);
    recentList.append(li);
  }
  recentWrap.hidden = list.length === 0;
}

// ── Разбор адреса ───────────────────────────────────────────────────────────

// Нормализуем и проверяем: только http(s) с валидным хостом → origin (путь
// отбрасываем). Мусор ("два слова", чужая схема) отсекаем — иначе URL молча
// percent-энкодит пробелы и пускает всё подряд.
function normalize(raw) {
  const trimmed = raw.trim();
  if (!trimmed || /\s/.test(trimmed)) return null;
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed);
  // Схема указана, но не http(s) — не наш случай.
  if (hasScheme && !/^https?:\/\//i.test(trimmed)) return null;
  const withProto = hasScheme ? trimmed : `https://${trimmed}`;
  let u;
  try {
    u = new URL(withProto);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  // Хост — домен (метки букв/цифр/дефисов через точку), IPv6 в скобках или
  // одиночная метка (localhost). Пробелы/спецсимволы сюда уже не пройдут.
  const validHost =
    /^(\[[0-9a-f:]+\]|[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*)$/i;
  return validHost.test(u.hostname) ? u.origin : null;
}

// ── Подключение ─────────────────────────────────────────────────────────────

// Идёт попытка подключения: контроллер её пробы и признак отмены пользователем
// (у AbortError не различить «отменили» и «истёк таймаут»).
let probeCtrl = null;
let cancelled = false;
// Номер текущей попытки. Пока идёт автопереход, список недавних кликабелен —
// и старая проба (сервер отвечает медленно) могла добежать уже после того, как
// человек выбрал другой адрес, и увести его на прежний. Результат попытки,
// которую обогнали, просто выбрасываем.
let attemptId = 0;

// Раньше при недоступном сервере жали «Подключиться» — и тишина: навигация
// молча падала где-то в webview, без ошибки на экране (так «не работал» клиент
// на Arch). Поэтому перед навигацией — быстрый probe тем же сетевым стеком
// webview: упал → показываем причину. Пробе можно не доверять (вдруг fetch с
// tauri:// зарезан, а навигация прошла бы) — на этот случай ссылка
// «перейти всё равно».
async function probe(origin) {
  probeCtrl = new AbortController();
  const t = setTimeout(() => probeCtrl.abort(), PROBE_MS);
  try {
    // no-cors: ответ непрозрачный, но сетевые ошибки (DNS/TLS/refused) всё
    // равно бросают TypeError — нам только это и нужно.
    await fetch(origin + '/', { mode: 'no-cors', cache: 'no-store', signal: probeCtrl.signal });
    return null;
  } catch (e) {
    if (cancelled) return null; // результат уже никого не интересует
    return e.name === 'AbortError' ? { timeout: true } : { detail: e.message || String(e) };
  } finally {
    clearTimeout(t);
    probeCtrl = null;
  }
}

function connect(origin) {
  remember(origin);
  // Знак «схватывается» и остаётся так, пока webview грузит web-UI: анимация
  // занимает уже существующее ожидание и ничего не задерживает.
  setLogo('connected');
  // Уводим окно на web-UI. Кука relay_pass живёт в webview, логин — /login там же.
  window.location.href = origin;
}

/** Показать форму выбора (после отмены автоперехода или неудачной пробы). */
function showPicker() {
  auto.hidden = true;
  form.hidden = false;
  hint.textContent = t('hint.pick');
  renderRecent();
}

/**
 * Проверить сервер и уйти на него. `viaAuto` — попытка автоперехода при старте:
 * у неё своя карточка с кнопкой «Отмена», а неудача возвращает к выбору адреса.
 */
async function attempt(origin, viaAuto = false) {
  const id = ++attemptId;
  cancelled = false;
  setStatus(viaAuto ? '' : t('status.checking'));
  setLogo('probing');
  skip.hidden = true;
  btn.disabled = true;
  const fail = await probe(origin);
  if (cancelled || id !== attemptId) return; // отменили или обогнала новая попытка
  btn.disabled = false;
  if (fail) {
    setLogo('idle');
    // Автопереход не удался — возвращаем экран выбора с причиной, а не
    // оставляем человека наедине с карточкой «проверяю».
    if (viaAuto) showPicker();
    // Секунды таймаута — в техническую строку, а не во фразу: в языках со
    // склонением числительных («10 секунд», но «2 секунды») подстановка числа
    // в предложение требует правил множественного числа ради одной строки.
    showError(t(fail.timeout ? 'error.timeout' : 'error.unreachable'), {
      detail: fail.timeout ? `timeout ${PROBE_MS / 1000}s` : fail.detail,
    });
    skip.hidden = false;
    skip.onclick = (ev) => {
      ev.preventDefault();
      connect(origin);
    };
    return;
  }
  setStatus('');
  connect(origin);
}

/** Отменить автопереход и остаться на экране выбора. */
function cancelAuto() {
  if (auto.hidden) return;
  cancelled = true;
  attemptId++; // результат текущей пробы больше не наш
  if (probeCtrl) probeCtrl.abort();
  setLogo('idle');
  showPicker();
}

form.addEventListener('submit', (e) => {
  e.preventDefault();
  const origin = normalize(input.value);
  if (!origin) {
    showError(t('error.invalidAddress'));
    return;
  }
  attempt(origin);
});

autoCancel.addEventListener('click', cancelAuto);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') cancelAuto();
});

// Пункт трея «Сменить сервер…» уводит окно на этот же экран с `#pick`. Если оно
// УЖЕ здесь (например автопереход ещё проверяет сервер), смена одного фрагмента
// страницу не перезагружает — ловим её отдельно, иначе пункт трея выглядел бы
// сломанным: нажал, а клиент всё равно ушёл на старый сервер.
window.addEventListener('hashchange', () => {
  if (location.hash === '#pick') cancelAuto();
});

// ── Контекстное меню ────────────────────────────────────────────────────────

// ПКМ в нативном клиенте не должен показывать меню движка («Назад», «Обновить»,
// «Просмотреть код») — это чужой интерфейс, по которому окно сразу читается как
// веб-страница. Экран выбора сервера маленький, поэтому и меню тут короткое:
// буфер обмена в поле адреса и действия над строкой недавних. Web-UI делает то
// же самое своим меню (apps/web/components/ui/ContextMenu.tsx).
// Shift+ПКМ оставляем движку — на случай отладки сборки.

const MOD = /mac/i.test(navigator.platform || navigator.userAgent) ? '⌘' : 'Ctrl+';
let ctxEl = null;
let ctxTouch = false;

function closeCtx() {
  ctxEl?.remove();
  ctxEl = null;
}

/** Показать меню в точке курсора; items — [{ label, hint, danger, run }]. */
function openCtx(x, y, items) {
  closeCtx();
  if (!items.length) return;
  const menu = document.createElement('div');
  menu.className = 'ctx';
  menu.setAttribute('role', 'menu');
  for (const it of items) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = it.danger ? 'ctx-item danger' : 'ctx-item';
    btn.setAttribute('role', 'menuitem');
    const label = document.createElement('span');
    label.textContent = it.label;
    btn.append(label);
    if (it.hint) {
      const hintEl = document.createElement('span');
      hintEl.className = 'ctx-hint';
      hintEl.textContent = it.hint;
      btn.append(hintEl);
    }
    // Фокус остаётся в поле — иначе «Вырезать»/«Вставить» потеряют выделение.
    btn.addEventListener('mousedown', (e) => e.preventDefault());
    btn.addEventListener('click', () => {
      closeCtx();
      it.run();
    });
    menu.append(btn);
  }
  document.body.append(menu);
  ctxEl = menu;
  // Прижимаем к экрану: у края меню раскрывается в другую сторону.
  const pad = 8;
  const flipX = x + menu.offsetWidth + pad > window.innerWidth;
  const flipY = y + menu.offsetHeight + pad > window.innerHeight;
  menu.style.left = `${Math.max(pad, flipX ? x - menu.offsetWidth : x)}px`;
  menu.style.top = `${Math.max(pad, flipY ? y - menu.offsetHeight : y)}px`;
  menu.style.transformOrigin = `${flipY ? 'bottom' : 'top'} ${flipX ? 'right' : 'left'}`;
}

/** Пункты буфера обмена для поля адреса. */
function fieldItems(field) {
  const items = [];
  const selected = field.value.slice(field.selectionStart ?? 0, field.selectionEnd ?? 0);
  const put = async (text) => {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      showError(t('clipboard.copyBlocked', { key: `${MOD}C` }), { shake: false });
      return false;
    }
  };
  if (selected) {
    items.push({
      label: t('menu.cut'),
      hint: `${MOD}X`,
      run: async () => {
        if (!(await put(selected))) return;
        const start = field.selectionStart;
        field.value = field.value.slice(0, start) + field.value.slice(field.selectionEnd);
        field.setSelectionRange(start, start);
      },
    });
    items.push({ label: t('menu.copy'), hint: `${MOD}C`, run: () => put(selected) });
  }
  items.push({
    label: t('menu.paste'),
    hint: `${MOD}V`,
    run: async () => {
      let text = '';
      try {
        text = await navigator.clipboard.readText();
      } catch {
        showError(t('clipboard.pasteBlocked', { key: `${MOD}V` }), { shake: false });
        return;
      }
      if (!text) return;
      const start = field.selectionStart ?? field.value.length;
      const end = field.selectionEnd ?? start;
      field.value = field.value.slice(0, start) + text + field.value.slice(end);
      field.setSelectionRange(start + text.length, start + text.length);
    },
  });
  if (field.value) {
    items.push({ label: t('menu.selectAll'), hint: `${MOD}A`, run: () => field.select() });
  }
  return items;
}

document.addEventListener('pointerdown', (e) => {
  ctxTouch = e.pointerType === 'touch';
  if (ctxEl && !ctxEl.contains(e.target)) closeCtx();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeCtx();
});
window.addEventListener('blur', closeCtx);
window.addEventListener('resize', closeCtx);

document.addEventListener('contextmenu', (e) => {
  if (e.shiftKey || ctxTouch) return; // аварийный выход к меню движка
  e.preventDefault();
  const field = e.target.closest('input');
  if (field) return openCtx(e.clientX, e.clientY, fieldItems(field));

  // Строка недавнего сервера: адрес в буфер и «убрать», чтобы не целиться в «×».
  const go = e.target.closest('.recent-go');
  if (go) {
    const origin = go.dataset.origin;
    return openCtx(e.clientX, e.clientY, [
      {
        label: t('menu.copyAddress'),
        hint: `${MOD}C`,
        run: () => navigator.clipboard?.writeText(origin).catch(() => {}),
      },
      { label: t('menu.removeFromList'), danger: true, run: () => forget(origin) },
    ]);
  }
  closeCtx(); // по пустому месту карточки — просто тишина вместо меню движка
});

// ── Проверка движка ─────────────────────────────────────────────────────────

// Системный WebKitGTK (Arch, Debian/Ubuntu — весь Linux, кто ставит пакет из
// репозитория) собран БЕЗ WebRTC: upstream держит `-DENABLE_WEB_RTC=OFF` по
// умолчанию и не кладёт его в тарболы. В таком движке getUserMedia на месте, а
// RTCPeerConnection нет вовсе — клиент заходил в канал, зажигал микрофон и
// молчал без единой ошибки. Проверяем ЗДЕСЬ, в том самом webview, который будет
// крутить web-UI, и говорим прямо — до того, как человек потратит вечер на
// «почему меня не слышно».
function checkWebrtc() {
  const PC = window.RTCPeerConnection || window.webkitRTCPeerConnection;
  // Мало имени в window: в урезанных сборках класс бывает объявлен, но без
  // методов согласования — звонок развалился бы уже после входа в канал.
  if (typeof PC === 'function' && typeof PC.prototype?.createOffer === 'function') return;

  const box = document.getElementById('no-webrtc');
  if (box) {
    box.hidden = false;
    const title = document.createElement('b');
    title.textContent = t('webrtc.title');
    const body = document.createElement('span');
    body.textContent = t('webrtc.body');
    box.replaceChildren(title, body);
  }

  // Тот же факт — в relay-update.log, чтобы он был виден в логе с машины
  // пользователя, а не только на экране, который никто не сфотографировал.
  try {
    window.__TAURI__?.event?.emit('webrtc-missing', navigator.userAgent);
  } catch {
    /* мост не поднялся — баннера на экране достаточно */
  }
}

checkWebrtc();

// ── Старт ───────────────────────────────────────────────────────────────────

// Прошлый адрес (или дефолт) — заранее в поле, чтобы «Подключиться» был в один
// клик.
const last = lastServer();
input.value = last || DEFAULT_SERVER;
renderRecent();

if (last && location.hash !== '#pick') {
  form.hidden = true;
  auto.hidden = false;
  hint.textContent = t('hint.auto');
  autoOrigin.textContent = last;
  attempt(last, true);
}
