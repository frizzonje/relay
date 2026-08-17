import { describe, expect, it } from 'vitest';
import { insertMention, mentions, splitMentions, typedMention, writtenIn } from './mentions';

/**
 * Упоминание в вебе — это три разных вопроса, и здесь проверяется каждый: как
 * названное имя выглядит в готовой реплике, что человек набирает после `@`
 * прямо сейчас и кто из выбранного им уедет на сервер.
 */

const anya = { fingerprint: 'f-anya', nick: 'Аня' };
const anyaK = { fingerprint: 'f-anya-k', nick: 'Аня К' };
const boris = { fingerprint: 'f-boris', nick: 'Борис' };

describe('имя в готовой реплике', () => {
  it('выделяется вместе с «@», остальное остаётся текстом', () => {
    expect(splitMentions('@Аня, ты идёшь?', [anya])).toEqual([
      { text: '@Аня', mention: anya },
      { text: ', ты идёшь?' },
    ]);
  });

  it('регистр не мешает — позвали именно того, кого назвали', () => {
    expect(splitMentions('привет, @аня', [anya])[1]).toEqual({ text: '@аня', mention: anya });
  });

  it('длинное имя выигрывает у короткого с тем же началом', () => {
    // Иначе «@Аня К» разъехалось бы на упоминание Ани и хвост « К».
    expect(splitMentions('@Аня К, привет', [anya, anyaK])[0]).toEqual({
      text: '@Аня К',
      mention: anyaK,
    });
  });

  it('«@» без знакомого имени — обычный текст', () => {
    expect(splitMentions('почта@дом.рф', [anya])).toEqual([{ text: 'почта@дом.рф' }]);
  });

  it('текст не теряется и не двоится', () => {
    const text = 'вот @Аня и @Борис, а вот никто';
    expect(
      splitMentions(text, [anya, boris])
        .map((s) => s.text)
        .join(''),
    ).toBe(text);
  });
});

describe('что набрано после «@»', () => {
  it('слово от «@» до курсора', () => {
    expect(typedMention('привет @ан', 10)).toEqual({ at: 7, query: 'ан' });
  });

  it('сразу после «@» — пустой запрос, а не «ничего не набрано»', () => {
    // Подсказка обязана открыться на самом «@»: список людей и есть подсказка.
    expect(typedMention('@', 1)).toEqual({ at: 0, query: '' });
  });

  it('пробел заканчивает набор', () => {
    expect(typedMention('@Аня привет', 11)).toBeNull();
  });

  it('в адресе почты никого не зовут', () => {
    expect(typedMention('почта@дом', 9)).toBeNull();
  });

  it('курсор перед «@» о нём ещё не знает', () => {
    expect(typedMention('привет @ан', 5)).toBeNull();
  });
});

describe('подстановка выбранного', () => {
  it('заменяет набранное целиком и ставит курсор за именем', () => {
    const { text, caret } = insertMention('привет @ан', { at: 7, query: 'ан' }, 'Аня');
    expect(text).toBe('привет @Аня ');
    expect(caret).toBe(text.length);
  });

  it('не плодит пробел перед тем, что уже написано дальше', () => {
    const { text } = insertMention('@ан идёшь?', { at: 0, query: 'ан' }, 'Аня');
    expect(text).toBe('@Аня идёшь?');
  });
});

describe('что уедет на сервер', () => {
  it('только те, чьё имя осталось в тексте', () => {
    // Выбрал в подсказке, потом стёр имя — звать молча нельзя.
    expect(writtenIn('@Аня, ты идёшь?', [anya, boris])).toEqual([anya]);
  });

  it('один человек — один отпечаток, сколько бы раз его ни назвали', () => {
    expect(writtenIn('@Аня @Аня', [anya, anya])).toEqual([anya]);
  });
});

describe('назвали ли тебя', () => {
  it('сверяется отпечаток, а не имя', () => {
    expect(mentions([anya], 'f-anya')).toBe(true);
    expect(mentions([anya], 'f-boris')).toBe(false);
    // Без ключа (гость по инвайту) подсвечивать нечего.
    expect(mentions([anya], undefined)).toBe(false);
    expect(mentions(undefined, 'f-anya')).toBe(false);
  });
});
