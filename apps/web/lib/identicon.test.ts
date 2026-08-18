import { describe, expect, it } from 'vitest';
import { identicon, identiconParams, identiconSvg } from './identicon';

/**
 * Identicon существует ради одного: чтобы подмена человека была заметна
 * боковым зрением. Значит проверять надо не «рисуется ли что-то», а что
 * рисунок стабилен во времени и разъезжается от чужого ключа.
 */

const A = '6668-7aad-f862-bd77';
const B = '16cc-cc1a-be5a-3301';

describe('стабильность', () => {
  it('один отпечаток — один рисунок', () => {
    expect(identiconSvg(A, 38)).toBe(identiconSvg(A, 38));
  });

  it('разделители в отпечатке ничего не меняют', () => {
    // Один и тот же ключ может приехать и с дефисами, и с точками, и без —
    // рисунок обязан остаться тем же, иначе человек «сменится» на ровном месте.
    expect(identiconParams(A)).toEqual(identiconParams(A.replace(/-/g, '')));
    expect(identiconParams(A)).toEqual(identiconParams(A.replace(/-/g, '·')));
    expect(identiconParams(A)).toEqual(identiconParams(A.toUpperCase()));
  });

  it('кеш отдаёт ровно то же, что и прямой вызов', () => {
    expect(identicon(A, 38)).toBe(identiconSvg(A, 38));
    expect(identicon(A, 38, { still: true })).toBe(identiconSvg(A, 38, { still: true }));
  });

  it('кеш не путает размер и неподвижность', () => {
    // Ключ кеша обязан включать всё, от чего зависит разметка: мелкий размер
    // меняет геометрию, «без движения» — наличие дрейфа.
    expect(identicon(A, 22)).not.toBe(identicon(A, 38));
    expect(identicon(A, 38, { still: true })).not.toBe(identicon(A, 38));
  });
});

describe('различимость', () => {
  it('другой ключ — другой рисунок', () => {
    expect(identiconParams(A)).not.toEqual(identiconParams(B));
  });

  it('участвует весь отпечаток, а не первые байты', () => {
    // Так и было в первой версии клетчатого identicon: рисунок читал два байта
    // из восьми, и ключи с общим началом давали одно лицо на всех.
    expect(identiconParams('aaaa-bbbb-cccc-dddd')).not.toEqual(
      identiconParams('aaaa-bbbb-cccc-ddde'),
    );
  });

  it('на тысяче ключей лица не схлопываются', () => {
    // Единственная проверка, которая ловит вырождение вообще: если рисунок
    // выводится не из всего, что дали, — здесь это видно как рой повторов.
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i += 1) {
      const print = Array.from({ length: 8 }, () =>
        Math.floor(Math.random() * 256)
          .toString(16)
          .padStart(2, '0'),
      ).join('');
      seen.add(JSON.stringify(identiconParams(print)));
    }
    expect(seen.size).toBeGreaterThan(990);
  });

  it('соседние лица не идут в такт', () => {
    // Период и фаза дрейфа тоже из отпечатка: одинаково дышащий ряд аватаров
    // читался бы как один общий индикатор, а не как разные люди.
    const ks = new Set(['1', '2', '3', '4', '5', '6'].map((s) => identiconParams(s).k));
    expect(ks.size).toBe(6);
  });
});

describe('разметка', () => {
  it('поле поворачивается снаружи размытия, а не внутри', () => {
    // Дрейф внутри размываемой группы заставлял бы пересчитывать гауссово
    // размытие каждый кадр — на ленте из полусотни лиц это и есть та самая
    // «дёрганность». Порядок групп здесь — не косметика.
    const svg = identiconSvg(A, 38);
    expect(svg.indexOf('animation:rlDrift')).toBeLessThan(svg.indexOf('filter="url(#f'));
  });

  it('пояса выделены всегда — речь не переписывает разметку', () => {
    // Разметка, зависящая от речи, менялась бы на каждое «заговорил», а с ней
    // заново начинался бы дрейф: лицо дёргалось бы к исходному положению по
    // нескольку раз в минуту. Имена кадров поясам даёт CSS по классу обёртки.
    const svg = identiconSvg(A, 38);
    for (const b of ['rl-b0', 'rl-b1', 'rl-b2']) expect(svg).toContain(`class="${b}"`);
    expect(svg).not.toContain('rlBand');
  });

  it('такт и фаза поясов — в разметке, а не в стилях', () => {
    // Период у каждого лица свой (выведен из отпечатка), а стиль один на всех:
    // окажись длительность в CSS, все говорящие били бы в такт.
    const svg = identiconSvg(A, 38);
    expect(svg).toMatch(/animation-duration:\d+\.\d+s/);
    expect(svg).toContain('animation-delay:0.11s');
  });

  it('«без движения» — значит без дрейфа', () => {
    // Не «анимация с нулевой длительностью», а её отсутствие: остановленная
    // анимация всё равно держит слой композитора.
    expect(identiconSvg(A, 38, { still: true })).not.toContain('rlDrift');
  });

  it('мелкий размер рисуется проще крупного', () => {
    // Ниже 30px тонкие линии превращаются в кашу, а лишняя разметка — в
    // единственную заметную цену аватара: их на экране бывает много.
    expect(identiconSvg(A, 22).length).toBeLessThan(identiconSvg(A, 38).length);
  });

  it('лицо весит меньше двенадцати килобайт', () => {
    // Лента рисует аватар на каждую реплику. Бюджет тут не эстетика, а
    // единственное, что удерживает разметку от превращения в мегабайт DOM:
    // на экран влезает десятка полтора реплик, и цена лица должна оставаться
    // сравнимой с ценой самой реплики, а не превосходить её на порядок.
    for (const size of [22, 32, 38, 84]) expect(identiconSvg(A, size).length).toBeLessThan(12_000);
  });

  it('id внутри выведены из отпечатка, а не из счётчика вызовов', () => {
    // Сквозной счётчик считает на сервере и на клиенте по-разному, и гидратация
    // ловила бы несовпадение разметки на каждом аватаре.
    const tag = identiconParams(A).tag;
    expect(identiconSvg(A, 38)).toContain(`id="f${tag}l"`);
    expect(identiconSvg(A, 22)).toContain(`id="f${tag}s"`);
  });
});

describe('кривой ввод', () => {
  it('пустой и нешестнадцатеричный отпечаток не роняют рисунок', () => {
    // Рисуется на каждое сообщение в ленте: уронить её из-за одной строки
    // было бы обменом несоразмерным.
    for (const bad of ['', '---', 'зззз', ' ']) {
      expect(() => identiconSvg(bad, 38)).not.toThrow();
      expect(identiconSvg(bad, 38)).toContain('<svg');
    }
  });

  it('у мусора тоже своё лицо, а не общее', () => {
    expect(identiconParams('зззз')).not.toEqual(identiconParams('ыыыы'));
  });
});
