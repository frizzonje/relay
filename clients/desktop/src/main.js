// Экран выбора сервера. Запоминает адреса инсталляций и уводит webview на web-UI
// relay — дальше весь UI (логин, чат, звонки) приходит из apps/web, десктоп его
// не форкает. Нативные фичи (трей, хоткеи) живут в Rust (src-tauri/src/main.rs).
//
// При старте клиент сам возвращается на последний сервер: пикер — это дорога,
// а не пункт назначения. Автопереход отменяем двумя способами:
//   • фрагмент `#pick` в URL — так пикер открывает пункт трея «Сменить сервер…»
//     (без этого экран уходил бы обратно на сервер, и адрес было бы не сменить);
//   • кнопка «Отмена» / Esc, пока идёт проверка доступности.

const KEY = "relay-desktop-server"; // последний сервер (ключ от 0.3.x, не менять)
const KEY_LIST = "relay-desktop-servers"; // недавние, свежий первым
const MAX_RECENT = 5;
const PROBE_MS = 10000;
// ВРЕМЕННО (тест): адрес, которым ПРЕДЗАПОЛНЯЕТСЯ пустое поле, чтобы вживую
// проверять сборки без ручного ввода. Убрать перед релизом — в проде адрес
// вводит пользователь. Автопереход этого адреса не касается: он идёт только на
// сервер, к которому уже подключались (см. lastServer) — свежая установка
// никуда сама не уйдёт.
const DEFAULT_SERVER = "https://overhype.tech";

const form = document.getElementById("form");
const input = document.getElementById("url");
const err = document.getElementById("err");
const btn = document.getElementById("go");
const skip = document.getElementById("skip");
const hint = document.getElementById("hint");
const auto = document.getElementById("auto");
const autoOrigin = document.getElementById("auto-origin");
const autoCancel = document.getElementById("auto-cancel");
const recentWrap = document.getElementById("recent-wrap");
const recentList = document.getElementById("recent");

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
    const parsed = JSON.parse(readLS(KEY_LIST) || "[]");
    if (Array.isArray(parsed)) list = parsed;
  } catch {
    /* битый JSON — начнём список заново */
  }
  const seen = new Set();
  const out = [];
  // Последний сервер мог прийти от версии без списка — не теряем его.
  for (const raw of [readLS(KEY), ...list]) {
    const origin = typeof raw === "string" ? normalize(raw) : null;
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
  if (readLS(KEY) && normalize(readLS(KEY)) === origin) writeLS(KEY, "");
  renderRecent();
}

function renderRecent() {
  const list = recentServers();
  recentList.replaceChildren();
  for (const origin of list) {
    const li = document.createElement("li");

    const go = document.createElement("button");
    go.type = "button";
    go.className = "recent-go";
    go.textContent = origin;
    go.title = origin;
    go.addEventListener("click", () => {
      input.value = origin;
      attempt(origin);
    });

    const del = document.createElement("button");
    del.type = "button";
    del.className = "recent-del";
    del.textContent = "×";
    del.title = "Убрать из списка";
    del.setAttribute("aria-label", `Убрать ${origin} из списка`);
    del.addEventListener("click", () => forget(origin));

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
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
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
    await fetch(origin + "/", { mode: "no-cors", cache: "no-store", signal: probeCtrl.signal });
    return null;
  } catch (e) {
    if (cancelled) return null; // результат уже никого не интересует
    return e.name === "AbortError" ? "нет ответа за 10 секунд" : e.message || String(e);
  } finally {
    clearTimeout(t);
    probeCtrl = null;
  }
}

function connect(origin) {
  remember(origin);
  // Уводим окно на web-UI. Кука relay_pass живёт в webview, логин — /login там же.
  window.location.href = origin;
}

/** Показать форму выбора (после отмены автоперехода или неудачной пробы). */
function showPicker() {
  auto.hidden = true;
  form.hidden = false;
  hint.textContent = "Адрес вашей инсталляции relay";
  renderRecent();
}

/**
 * Проверить сервер и уйти на него. `viaAuto` — попытка автоперехода при старте:
 * у неё своя карточка с кнопкой «Отмена», а неудача возвращает к выбору адреса.
 */
async function attempt(origin, viaAuto = false) {
  const id = ++attemptId;
  cancelled = false;
  err.textContent = viaAuto ? "" : "Проверяю доступность…";
  skip.hidden = true;
  btn.disabled = true;
  const fail = await probe(origin);
  if (cancelled || id !== attemptId) return; // отменили или обогнала новая попытка
  btn.disabled = false;
  if (fail) {
    // Автопереход не удался — возвращаем экран выбора с причиной, а не
    // оставляем человека наедине с карточкой «проверяю».
    if (viaAuto) showPicker();
    err.textContent = `Сервер недоступен: ${fail}. Проверьте адрес и сеть.`;
    skip.hidden = false;
    skip.onclick = (ev) => {
      ev.preventDefault();
      connect(origin);
    };
    return;
  }
  err.textContent = "";
  connect(origin);
}

/** Отменить автопереход и остаться на экране выбора. */
function cancelAuto() {
  if (auto.hidden) return;
  cancelled = true;
  attemptId++; // результат текущей пробы больше не наш
  if (probeCtrl) probeCtrl.abort();
  showPicker();
}

form.addEventListener("submit", (e) => {
  e.preventDefault();
  const origin = normalize(input.value);
  if (!origin) {
    err.textContent = "Введите адрес вида https://relay.example.com";
    return;
  }
  attempt(origin);
});

autoCancel.addEventListener("click", cancelAuto);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") cancelAuto();
});

// Пункт трея «Сменить сервер…» уводит окно на этот же экран с `#pick`. Если оно
// УЖЕ здесь (например автопереход ещё проверяет сервер), смена одного фрагмента
// страницу не перезагружает — ловим её отдельно, иначе пункт трея выглядел бы
// сломанным: нажал, а клиент всё равно ушёл на старый сервер.
window.addEventListener("hashchange", () => {
  if (location.hash === "#pick") cancelAuto();
});

// ── Старт ───────────────────────────────────────────────────────────────────

// Прошлый адрес (или тестовый дефолт) — заранее в поле, чтобы «Подключиться»
// был в один клик.
const last = lastServer();
input.value = last || DEFAULT_SERVER;
renderRecent();

if (last && location.hash !== "#pick") {
  form.hidden = true;
  auto.hidden = false;
  hint.textContent = "Возвращаемся на ваш сервер";
  autoOrigin.textContent = last;
  attempt(last, true);
}
