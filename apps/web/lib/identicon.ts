/**
 * Identicon «Аврора 9c» — лицо личности, выведенное из отпечатка ключа.
 *
 * Зачем он вообще: ники в 1.0 свободные и НЕ уникальные, так что двух «Ань»
 * различает только ключ. Читать шестнадцать шестнадцатеричных цифр глазами при
 * каждом сообщении никто не станет — а вот заметить, что у сегодняшней «Ани»
 * другой рисунок, человек может боковым зрением. Это и есть его работа: не
 * доказать личность (доказывает подпись), а сделать подмену заметной.
 *
 * Отсюда два требования, и они важнее красоты:
 *
 *   1. **Детерминированность.** Один отпечаток — один рисунок, всегда и везде,
 *      на любом клиенте. Поэтому вычисление живёт здесь одно, а не растекается
 *      по компонентам, и после выпуска 1.0 менять его будет нельзя: смена
 *      алгоритма перерисует всех людей разом и обесценит именно ту память, ради
 *      которой identicon существует. (До выпуска — можно, чем этот файл и
 *      воспользовался: клетчатую сетку сменило поле «Аврора 9c».)
 *   2. **Различимость.** Рисунок должен разъезжаться от малого изменения входа.
 *      Отпечаток выведен из SHA-256, биты распределены равномерно сами; наше
 *      дело — прогнать их через хеш целиком, а не взять первые байты.
 *
 * Форма: поле горизонтальных линий, стянутых к «ядру» — точке притяжения,
 * положение которой тоже из отпечатка. Линза даёт узнаваемый силуэт складки,
 * размытие превращает линии в свечение. Из отпечатка выводится всё: тон, угол
 * поля, ядро, сила линзы, число линий, период и фаза дрейфа.
 *
 * Движение — часть лица, а не украшение:
 *   • покой   — поле медленно наплывает (`rlDrift`), период у каждого свой,
 *               поэтому два аватара рядом никогда не идут в такт;
 *   • речь    — три пояса вокруг ядра расходятся по очереди (`rlBand0..2`).
 *               Реагирует само изображение, а не кольцо вокруг него.
 * Кадры лежат в globals.css; `prefers-reduced-motion` останавливает всё.
 *
 * Речь при этом не переписывает разметку: пояса выделены всегда, а класс
 * `rl-identicon-speaking` на обёртке лишь даёт им имена кадров. Иначе каждое
 * «заговорил» подменяло бы содержимое картинки и начинало дрейф заново — лицо
 * дёргалось бы именно в те секунды, когда на него смотрят.
 */

/** Тона свечения. Цвет — единственная вольность в холодной палитре relay. */
const HUES = [206, 258, 168, 32, 222, 318];

/** Ниже этого размера поле рисуется реже и размывается слабее: иначе каша. */
const SMALL = 30;

/** Насыщенность: край поля | ядро. */
const SAT = [16, 30];

/** Три обводки одной линии: ширина×, светлота%, прозрачность×. */
const STACK: [number, number, number][] = [
  [5.6, 14, 0.5], // зарево
  [2.8, 52, 0.5], // вал
  [1.25, 94, 0.85], // гребень
];

const BLUR = [2.2, 2.8]; // мелкий | обычный
const SPEC = 0.08; // блик
const BG = [20, 7]; // светлота фона: у ядра | у края
const VIG = 0.72; // виньетка

export interface IdenticonParams {
  /** Тон свечения. */
  h: number;
  /** Поворот поля, градусы. */
  ang: number;
  /** Точка притяжения в системе 40×40. */
  fx: number;
  fy: number;
  /** Сила линзы. */
  str: number;
  /** Число линий поля. */
  lines: number;
  /** Фаза дрейфа, с (отрицательная — анимация начинается не с нуля). */
  delay: number;
  /** Множитель периода. */
  k: number;
  /** Направление дрейфа. */
  dir: 1 | -1;
  /** Хвост хеша — им метятся id внутри SVG (см. ниже). */
  tag: string;
}

export interface IdenticonOptions {
  /**
   * Совсем без движения. Нужно там, где аватаров на экране может быть сколько
   * угодно (лента сообщений): полсотни независимо дышащих размытых полей —
   * это уже не «живо», а «греется вентилятор».
   */
  still?: boolean;
}

/**
 * Отпечаток к каноническому виду: `7f2a·c091`, `7f2a-c091` и `7F2AC091` —
 * один и тот же ключ, и лицо у него обязано быть одно. Если шестнадцатеричного
 * в строке нет вовсе (гость, мусор), сеем из неё самой — пусть у неё будет
 * своё лицо, лишь бы стабильное.
 */
function normalize(fingerprint: string): string {
  const hex = String(fingerprint)
    .toLowerCase()
    .replace(/[^0-9a-f]/g, '');
  return hex || String(fingerprint).trim().toLowerCase();
}

/** FNV-1a: 32 бита, все байты входа участвуют. */
function seedOf(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Детерминированный ПСЧ (mulberry32) — из зерна растёт весь рисунок. */
function rngOf(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Все параметры рисунка — из отпечатка, и только из него. */
export function identiconParams(fingerprint: string): IdenticonParams {
  const seed = seedOf(normalize(fingerprint));
  const r = rngOf(seed);
  return {
    h: HUES[Math.floor(r() * HUES.length)],
    ang: Math.round(r() * 180),
    fx: 13 + r() * 14,
    fy: 13 + r() * 14,
    str: 22 + r() * 14,
    lines: 9 + Math.floor(r() * 5),
    delay: -Number((r() * 8).toFixed(1)),
    k: 0.88 + r() * 0.24,
    dir: r() < 0.5 ? 1 : -1,
    tag: seed.toString(36),
  };
}

interface FieldLine {
  pts: [number, number][];
  /** Близость линии к ядру, 0–1: ею задаются толщина, свет и пояс. */
  prox: number;
}

/** Поле линий, стянутых к ядру и посаженных на сетку. */
function fieldLines(c: IdenticonParams, small: boolean): FieldLine[] {
  const n = small ? Math.round(c.lines * 0.62) : c.lines;
  const soft = small ? 4.6 : 3.6;
  const strength = c.str * (small ? 0.85 : 1);
  const step = small ? 2.2 : 1.5;
  const q = 2.2 * (small ? 1.4 : 1);
  const out: FieldLine[] = [];
  for (let i = 0; i < n; i += 1) {
    const y0 = -4 + (48 * (i + 0.5)) / n;
    const pts: [number, number][] = [];
    for (let x = -6; x <= 46.001; x += step) {
      const dx = x - c.fx;
      const dy = y0 - c.fy;
      const r = Math.hypot(dx, dy) || 0.001;
      const pull = Math.min(strength / (r + soft), r * 0.86);
      pts.push([
        Math.round((x - (dx / r) * pull) / q) * q,
        Math.round((y0 - (dy / r) * pull) / q) * q,
      ]);
    }
    out.push({ pts, prox: Math.exp(-Math.abs(y0 - c.fy) / 12) });
  }
  return out;
}

/** Ступени сетки скругляются квадратичными сегментами. */
function smooth(pts: [number, number][]): string {
  const p = pts.filter((v, i, a) => i === 0 || v[0] !== a[i - 1][0] || v[1] !== a[i - 1][1]);
  const at = (v: [number, number]) => `${v[0].toFixed(1)} ${v[1].toFixed(1)}`;
  if (p.length < 3) return `M${p.map(at).join('L')}`;
  let d = `M${at(p[0])}`;
  for (let i = 1; i < p.length - 1; i += 1) {
    d +=
      `Q${at(p[i])} ` +
      `${((p[i][0] + p[i + 1][0]) / 2).toFixed(1)} ${((p[i][1] + p[i + 1][1]) / 2).toFixed(1)}`;
  }
  return `${d}L${at(p[p.length - 1])}`;
}

/**
 * Одна обводка линии: чем ближе к ядру, тем толще, светлее и плотнее.
 *
 * Геометрия не повторяется, а берётся ссылкой: каждая линия рисуется тремя
 * обводками — заревом, валом и гребнем, — и три копии одного и того же пути в
 * разметке стоили вдвое больше всего остального аватара вместе взятого.
 */
function stroke(c: IdenticonParams, L: FieldLine, id: string, base: number, s: number[]): string {
  const [wm, lg, om] = s;
  const w = base * (0.6 + 1.05 * L.prox) * wm;
  const op = (0.22 + 0.74 * L.prox) * om;
  const sat = Math.round(SAT[0] + (SAT[1] - SAT[0]) * L.prox);
  const light = Math.round(lg * (0.45 + 0.62 * L.prox));
  return (
    `<use href="#${id}" stroke="hsl(${c.h} ${sat}% ${light}%)"` +
    ` stroke-opacity="${op.toFixed(2)}" stroke-width="${w.toFixed(2)}"/>`
  );
}

/**
 * Рисунок целиком, строкой SVG.
 *
 * Про id внутри: они выведены из отпечатка, а не из сквозного счётчика. Счётчик
 * на сервере и на клиенте считает по-разному, и гидратация ловила бы
 * несовпадение разметки на каждом аватаре. Одинаковые id у двух одинаковых
 * аватаров в документе формально «дубль», но содержимое у них до байта одно и
 * то же, и браузер честно возьмёт первое попавшееся — то же самое.
 *
 * Про порядок «дрейф снаружи размытия»: в референсе дрейф лежит ВНУТРИ
 * размываемой группы, и тогда каждый кадр анимации заставляет пересчитывать
 * гауссово размытие заново. Снаружи — размытие считается один раз, а двигается
 * уже готовый слой. Разницы на глаз нет (размытие изотропно), разница в
 * нагрузке — та, ради которой это и переставлено.
 */
export function identiconSvg(
  fingerprint: string,
  size: number,
  opts: IdenticonOptions = {},
): string {
  const c = identiconParams(fingerprint);
  const small = size < SMALL;
  const g = c.tag + (small ? 's' : 'l');
  const lines = fieldLines(c, small);
  const base = small ? 1.55 : 1.05;
  const blur = small ? BLUR[0] : BLUR[1];

  // Геометрия линий объявляется один раз, обводки ссылаются на неё.
  const shapes: string[] = [];
  const paint = (L: FieldLine, i: number) => {
    const id = `p${g}_${i}`;
    shapes.push(`<path id="${id}" d="${smooth(L.pts)}"/>`);
    return STACK.map((s) => stroke(c, L, id, base, s)).join('');
  };
  // Поле всегда разложено на три пояса вокруг ядра — и у молчащего тоже.
  // Речь не перестраивает разметку, а лишь включает поясам кадры (класс
  // `rl-identicon-speaking` на обёртке, имена кадров — в globals.css).
  //
  // Так сделано не ради красоты кода. Разметка, зависящая от речи, менялась бы
  // на каждое «заговорил» и «замолчал», а вместе с ней заново начинался бы
  // дрейф — и лицо дёргалось бы к исходному положению по нескольку раз в
  // минуту, ровно в те секунды, когда на него и смотрят.
  const org = `${c.fx.toFixed(1)}px ${c.fy.toFixed(1)}px`;
  const bands: string[][] = [[], [], []];
  lines.forEach((L, i) => bands[L.prox > 0.72 ? 0 : L.prox > 0.38 ? 1 : 2].push(paint(L, i)));
  // Длительность и фаза у каждого лица свои, поэтому лежат в разметке: имя
  // кадров добавит CSS, а всё остальное анимации уже задано здесь.
  const beat =
    `animation-duration:${(1.55 * c.k).toFixed(2)}s;` +
    `animation-timing-function:cubic-bezier(.25,.9,.3,1);animation-iteration-count:infinite`;
  let inner =
    `<g filter="url(#f${g})">` +
    bands
      .map(
        (body, i) =>
          `<g class="rl-b${i}" style="transform-origin:${org};${beat};` +
          `animation-delay:${(i * 0.11).toFixed(2)}s">${body.join('')}</g>`,
      )
      .join('') +
    `</g>`;
  // Собрать defs можно только теперь: пути наполнились по ходу отрисовки.

  if (!opts.still) {
    const drift =
      `transform-origin:20px 20px;animation:rlDrift ${(6.5 * c.k).toFixed(1)}s ease-in-out` +
      ` ${c.delay}s infinite ${c.dir > 0 ? 'normal' : 'reverse'}`;
    inner = `<g style="${drift}">${inner}</g>`;
  }

  const defs =
    // Область размытия задана в координатах картинки, а не долями от рамки
    // содержимого. Доли годились, пока размывалось всё поле разом: его рамка —
    // почти весь холст. У говорящего поле разбито на три пояса, и у пояса из
    // одной линии своя рамка — тонкая полоска, за краем которой размытие
    // обрывается. На диске это читалось как проведённая по нему черта.
    `<filter id="f${g}" filterUnits="userSpaceOnUse" x="-12" y="-12" width="64" height="64">` +
    `<feGaussianBlur stdDeviation="${blur}"/></filter>` +
    `<radialGradient id="bg${g}" cx="${((c.fx / 40) * 100).toFixed(1)}%" cy="${((c.fy / 40) * 100).toFixed(1)}%" r="82%">` +
    `<stop offset="0" stop-color="hsl(${c.h} ${SAT[1]}% ${BG[0]}%)"/>` +
    `<stop offset=".6" stop-color="hsl(${c.h} ${SAT[0]}% ${BG[1]}%)"/>` +
    `<stop offset="1" stop-color="#040507"/></radialGradient>` +
    `<radialGradient id="sp${g}" cx="30%" cy="24%" r="52%">` +
    `<stop offset="0" stop-color="#fff" stop-opacity="${SPEC}"/>` +
    `<stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient>` +
    `<radialGradient id="vg${g}" cx="50%" cy="50%" r="50%">` +
    `<stop offset=".42" stop-color="#000" stop-opacity="0"/>` +
    `<stop offset="1" stop-color="#000" stop-opacity="${VIG}"/></radialGradient>` +
    `<clipPath id="cp${g}"><circle cx="20" cy="20" r="20"/></clipPath>` +
    shapes.join('');

  return (
    `<svg viewBox="0 0 40 40" width="${size}" height="${size}" style="display:block" aria-hidden="true">` +
    `<defs>${defs}</defs><g clip-path="url(#cp${g})">` +
    `<rect width="40" height="40" fill="url(#bg${g})"/>` +
    // Общее для всех обводок вынесено сюда: наследуемые свойства ходят вниз
    // сами, а тридцать девять раз повторённое «fill=none» — это лишний
    // килобайт на каждое лицо.
    `<g transform="rotate(${c.ang} 20 20)" fill="none" stroke-linecap="round" stroke-linejoin="round">${inner}</g>` +
    `<rect width="40" height="40" fill="url(#vg${g})"/>` +
    `<rect width="40" height="40" fill="url(#sp${g})"/></g></svg>`
  );
}

/**
 * Кеш готовых строк. Генерация чистая и недешёвая (сотня квадратичных
 * сегментов на аватар), а один и тот же человек в ленте встречается десятками
 * реплик подряд — считать ему лицо каждый раз незачем.
 *
 * Ключ — отпечаток, размер и неподвижность. Речи в ключе нет: она не меняет
 * разметку вовсе, а только зажигает кадры поясам классом на обёртке.
 */
const cache = new Map<string, string>();
const CACHE_MAX = 256;

export function identicon(fingerprint: string, size: number, opts: IdenticonOptions = {}): string {
  const key = `${fingerprint}|${size}|${opts.still ? 's' : ''}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const svg = identiconSvg(fingerprint, size, opts);
  // Выкидываем самое старое: людей на глазах у человека конечное число, и
  // держать лица всех, кого он видел за сессию, ни к чему.
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value as string);
  cache.set(key, svg);
  return svg;
}
