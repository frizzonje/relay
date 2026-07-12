// Экран выбора сервера. Запоминает адрес инсталляции и уводит webview на web-UI
// relay — дальше весь UI (логин, чат, звонки) приходит из apps/web, десктоп его
// не форкает. Нативные фичи (трей, хоткеи) живут в Rust (src-tauri/src/main.rs).

const KEY = "relay-desktop-server";
// ВРЕМЕННО (тест): дефолтный сервер, чтобы вживую проверить нативную связку
// (PTT-хоткей + статусы трея) без ручного ввода. Убрать перед релизом —
// в проде адрес вводит пользователь. Требует валидного TLS-серта (Let's Encrypt):
// с самоподписанным Caddy-сертом webview отклонит навигацию.
const DEFAULT_SERVER = "https://overhype.tech";
const input = document.getElementById("url");
const form = document.getElementById("form");
const err = document.getElementById("err");

// Прошлый адрес (или тестовый дефолт) — заранее в поле, чтобы «Подключиться»
// был в один клик.
input.value = localStorage.getItem(KEY) || DEFAULT_SERVER;

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

form.addEventListener("submit", (e) => {
  e.preventDefault();
  const origin = normalize(input.value);
  if (!origin) {
    err.textContent = "Введите адрес вида https://relay.example.com";
    return;
  }
  err.textContent = "";
  localStorage.setItem(KEY, origin);
  // Уводим окно на web-UI. Кука relay_pass живёт в webview, логин — /login там же.
  window.location.href = origin;
});
