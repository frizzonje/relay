// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_CHANNELS, MAIN_SERVER_ID } from '@/lib/constants';
import { useAudioUnlockStore } from './audio-unlock';
import { useChannelsStore } from './channels';
import { useChatStore } from './chat';
import { useHostsStore } from './hosts';
import { PREF_STORAGE } from '@/lib/prefs';
import { isChannelLoud, useNotifyStore } from './notify';
import { isServerUnlocked, useServersStore } from './servers';
import { LAST_READ_KEY, channelMentions, isChannelUnread, useUnreadStore } from './unread';

/**
 * Сторы интерфейса. Самый содержательный здесь — «непрочитанное»: время в нём
 * ВЕЗДЕ серверное, и отметка чтения ставится текущей активностью канала, а не
 * `Date.now()` браузера. Разойдись часы клиента и сервера — точка либо не
 * гаснет после открытия канала, либо не загорается вовсе; проверяем именно это.
 */

beforeEach(() => {
  localStorage.clear();
  useUnreadStore.setState({
    activity: {},
    lastRead: {},
    divider: {},
    mentions: {},
    atBottom: true,
  });
  useChatStore.getState().reset();
  useChannelsStore.setState({ channels: DEFAULT_CHANNELS });
  useServersStore.setState({
    activeServerId: MAIN_SERVER_ID,
    unlockedIds: [],
    unlockTargetId: null,
    unlockError: null,
  });
  useHostsStore.setState({ hosts: [], hydrated: false });
  useAudioUnlockStore.setState({ shown: false });
  useNotifyStore.setState({ loud: [], pings: {} });
});

describe('непрочитанное', () => {
  const s = () => useUnreadStore.getState();

  it('канал непрочитан, пока активность новее отметки чтения', () => {
    s().noteActivity('obshchii', 1000);
    expect(isChannelUnread(s(), 'obshchii')).toBe(true);
    s().readNow('obshchii');
    expect(isChannelUnread(s(), 'obshchii')).toBe(false);
  });

  it('отметка чтения ставится серверным временем канала, а не часами браузера', () => {
    s().noteActivity('obshchii', 1000);
    s().readNow('obshchii');
    expect(s().lastRead.obshchii).toBe(1000);
  });

  it('пинг из прошлого не отматывает активность назад', () => {
    s().noteActivity('obshchii', 2000);
    s().noteActivity('obshchii', 1000);
    expect(s().activity.obshchii).toBe(2000);
  });

  it('мусорное время и пустой слаг игнорируются', () => {
    s().noteActivity('', 1000);
    s().noteActivity('obshchii', NaN);
    s().noteActivity('obshchii', Infinity);
    expect(s().activity).toEqual({});
  });

  it('снимок из реестра поднимает активность пачкой — точки горят сразу после загрузки', () => {
    s().seedActivity([
      { slug: 'obshchii', ts: 500 },
      { slug: 'второй', ts: 700 },
    ]);
    expect(s().activity).toEqual({ obshchii: 500, второй: 700 });
    // Ничего нового — состояние не пересоздаём (стор не дёргает подписчиков).
    const before = s().activity;
    s().seedActivity([{ slug: 'obshchii', ts: 100 }]);
    expect(s().activity).toBe(before);
  });

  it('вход в канал гасит точку, но линию «новые» оставляет на прежней отметке', () => {
    s().noteActivity('obshchii', 1000);
    s().readNow('obshchii');
    s().noteActivity('obshchii', 2000);

    s().openChannel('obshchii');
    // Линия там, где дочитали, — иначе она исчезла бы ровно тогда, когда нужна.
    expect(s().dividerAt('obshchii')).toBe(1000);
    expect(isChannelUnread(s(), 'obshchii')).toBe(false);
  });

  it('вход в уже прочитанный канал не переписывает отметку', () => {
    s().noteActivity('obshchii', 1000);
    s().readNow('obshchii');
    s().openChannel('obshchii');
    expect(s().lastRead.obshchii).toBe(1000);
    expect(s().dividerAt('obshchii')).toBe(1000);
  });

  it('отвернулись — линия встаёт на текущей отметке, всё дальнейшее под ней', () => {
    s().noteActivity('obshchii', 1000);
    s().readNow('obshchii');
    s().pauseAt('obshchii');
    expect(s().dividerAt('obshchii')).toBe(1000);
    // Повтор ничего не меняет.
    const before = s().divider;
    s().pauseAt('obshchii');
    expect(s().divider).toBe(before);
    s().pauseAt('');
    expect(s().divider).toBe(before);
  });

  it('линия для канала, куда не заходили, — ноль, а не undefined', () => {
    expect(s().dividerAt('никакой')).toBe(0);
  });

  it('отметки переживают перезагрузку', () => {
    s().noteActivity('obshchii', 1000);
    s().readNow('obshchii');
    expect(JSON.parse(localStorage.getItem(LAST_READ_KEY)!)).toEqual({ obshchii: 1000 });
  });

  it('отметки соседней вкладки принимаются, но только вперёд', () => {
    s().noteActivity('obshchii', 3000);
    s().readNow('obshchii');
    s().adoptLastRead(JSON.stringify({ obshchii: 5000, второй: 100 }));
    expect(s().lastRead).toEqual({ obshchii: 5000, второй: 100 });

    const before = s().lastRead;
    s().adoptLastRead(JSON.stringify({ obshchii: 1 }));
    expect(s().lastRead).toBe(before);
  });

  it('прочитанное на другом устройстве гасит точку и здесь', () => {
    s().noteActivity('obshchii', 5000);
    expect(isChannelUnread(s(), 'obshchii')).toBe(true);

    // Снимок с сервера: человек дочитал этот канал с телефона.
    expect(s().adoptMarks({ obshchii: 5000 })).toEqual([]);
    expect(isChannelUnread(s(), 'obshchii')).toBe(false);
    // В кэш тоже — он отвечает в первый кадр следующей загрузки, до сокета.
    expect(JSON.parse(localStorage.getItem(LAST_READ_KEY)!)).toEqual({ obshchii: 5000 });
  });

  it('снимок отдаёт наверх прочитанное до появления личности', () => {
    s().noteActivity('obshchii', 3000);
    s().noteActivity('флуд', 4000);
    s().readNow('obshchii');
    s().readNow('флуд');

    // Сервер знает про один канал и отстал; про второй не знает вовсе.
    expect(s().adoptMarks({ obshchii: 1000 }, { full: true })).toEqual([
      { slug: 'obshchii', ts: 3000 },
      { slug: 'флуд', ts: 4000 },
    ]);
  });

  it('на правку с другого устройства своим списком не отвечают', () => {
    s().noteActivity('флуд', 4000);
    s().readNow('флуд');
    // Иначе два устройства устроили бы друг другу вечную переписку.
    expect(s().adoptMarks({ obshchii: 1000 })).toEqual([]);
    expect(s().lastRead).toEqual({ флуд: 4000, obshchii: 1000 });
  });

  it('отметка с сервера назад не ходит', () => {
    s().noteActivity('obshchii', 5000);
    s().readNow('obshchii');
    const before = s().lastRead;
    s().adoptMarks({ obshchii: 1000 });
    expect(s().lastRead).toBe(before);
  });

  it('битое содержимое из соседней вкладки не роняет индикатор', () => {
    for (const junk of ['{не json', 'null', '"строка"', '{"obshchii":"вчера"}', null]) {
      expect(() => s().adoptLastRead(junk)).not.toThrow();
    }
    expect(s().lastRead).toEqual({});
  });

  it('нечитаемое хранилище не мешает работать', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('приватный режим');
    });
    s().noteActivity('obshchii', 1000);
    expect(() => s().readNow('obshchii')).not.toThrow();
    expect(s().lastRead.obshchii).toBe(1000);
    vi.restoreAllMocks();
  });

  it('положение ленты меняется только на самом деле', () => {
    const before = useUnreadStore.getState();
    s().setAtBottom(true);
    expect(useUnreadStore.getState().atBottom).toBe(true);
    s().setAtBottom(false);
    expect(useUnreadStore.getState().atBottom).toBe(false);
    expect(before.atBottom).toBe(true);
  });

  describe('счётчик упоминаний', () => {
    it('растёт на каждом вызове и гаснет, когда канал дочитан', () => {
      s().noteMention('obshchii');
      s().noteMention('obshchii');
      expect(channelMentions(s(), 'obshchii')).toBe(2);

      s().noteActivity('obshchii', 1000);
      s().readNow('obshchii');
      expect(channelMentions(s(), 'obshchii')).toBe(0);
    });

    it('гаснет и тогда, когда отметка чтения не сдвинулась', () => {
      // Снимок счётчиков приезжает после отметок: канал уже дочитан, и «тебя
      // звали» осталось бы гореть в прочитанном.
      s().noteActivity('obshchii', 1000);
      s().readNow('obshchii');
      s().noteMention('obshchii');
      s().readNow('obshchii');
      expect(channelMentions(s(), 'obshchii')).toBe(0);
    });

    it('вход в канал гасит его счётчик', () => {
      s().noteMention('obshchii');
      s().openChannel('obshchii');
      expect(channelMentions(s(), 'obshchii')).toBe(0);
    });

    it('дочитано на другом устройстве — погасло и здесь', () => {
      s().noteMention('obshchii');
      s().noteMention('флуд');
      s().adoptMarks({ obshchii: 5000 });
      expect(channelMentions(s(), 'obshchii')).toBe(0);
      // Соседний канал при этом не трогаем: там не читали.
      expect(channelMentions(s(), 'флуд')).toBe(1);
    });

    it('снимок с сервера заменяет счётчики, а не складывается с ними', () => {
      s().noteMention('obshchii');
      s().seedMentions({ флуд: 3 });
      expect(channelMentions(s(), 'obshchii')).toBe(0);
      expect(channelMentions(s(), 'флуд')).toBe(3);
    });

    it('мусор в снимке ничего не зажигает', () => {
      s().seedMentions({ obshchii: 0, флуд: -2, чат: 'много' as unknown as number });
      expect(s().mentions).toEqual({});
    });
  });
});

describe('лента чата', () => {
  const s = () => useChatStore.getState();
  const msg = (id: string, text = 'привет') => ({ id, name: 'A', text, ts: 1 });

  it('сообщения копятся, история заменяет ленту целиком', () => {
    s().addMessage(msg('1'));
    s().addMessage(msg('2'));
    expect(s().messages.map((m) => m.id)).toEqual(['1', '2']);
    s().setHistory([msg('9')]);
    expect(s().messages.map((m) => m.id)).toEqual(['9']);
  });

  it('реакция, правка и удаление находят сообщение по id', () => {
    s().setHistory([msg('1'), msg('2')]);
    s().applyReaction('1', { '🔥': [{ nick: 'A' }] });
    expect(s().messages[0].reactions).toEqual({ '🔥': [{ nick: 'A' }] });
    s().applyEdit('2', 'переписал', 555);
    expect(s().messages[1]).toMatchObject({ text: 'переписал', editedTs: 555 });
    s().applyDelete('1');
    expect(s().messages.map((m) => m.id)).toEqual(['2']);
  });

  it('действие по неизвестному id ничего не портит', () => {
    s().setHistory([msg('1')]);
    s().applyEdit('нет', 'x', 1);
    s().applyDelete('нет');
    s().applyReaction('нет', {});
    expect(s().messages).toHaveLength(1);
    expect(s().messages[0].text).toBe('привет');
  });

  it('окно из поиска заменяет ленту и объявляет, что канал есть и ниже', () => {
    s().setHistory([msg('свежее')], false);
    s().setWindow([msg('старое')], true, true);
    expect(s().messages.map((m) => m.id)).toEqual(['старое']);
    expect([s().more, s().moreAfter]).toEqual([true, true]);
  });

  it('лента в прошлом не принимает новые реплики — между ними дыра', () => {
    s().setWindow([msg('старое')], false, true);
    s().addMessage(msg('только что'));
    // Приклеить новое к куску из прошлого значило бы показать разговор,
    // которого не было: между ними лежит непрогруженное.
    expect(s().messages.map((m) => m.id)).toEqual(['старое']);
  });

  it('страница снизу склеивается по id, а не по длине', () => {
    s().setWindow([msg('1'), msg('2')], false, true);
    s().appendHistory([msg('2'), msg('3')], false);
    expect(s().messages.map((m) => m.id)).toEqual(['1', '2', '3']);
    expect(s().moreAfter).toBe(false);
  });

  it('возврат к последним снимает и «ниже есть ещё», и метку перехода', () => {
    s().setWindow([msg('старое')], true, true);
    s().setJump('старое');
    s().setHistory([msg('свежее')], false);
    expect([s().moreAfter, s().jump]).toEqual([false, null]);
  });

  it('сброс чистит и ленту, и состав, и «печатает»', () => {
    s().addMessage(msg('1'));
    s().setRoster(['A', 'B']);
    s().setTyping(['B']);
    s().reset();
    expect([s().messages, s().roster, s().typing]).toEqual([[], [], []]);
  });
});

describe('реестр серверов', () => {
  const s = () => useServersStore.getState();

  it('удалили открытый сервер — откатываемся на главный, а не в пустоту', () => {
    s().setServers([
      { id: MAIN_SERVER_ID, name: 'relay', removable: false },
      { id: 'srv', name: 'мой', removable: true },
    ]);
    s().setActiveServer('srv');
    expect(s().activeServerId).toBe('srv');
    s().setServers([{ id: MAIN_SERVER_ID, name: 'relay', removable: false }]);
    expect(s().activeServerId).toBe(MAIN_SERVER_ID);
  });

  it('открытый сервер остаётся открытым, пока он в списке', () => {
    const list = [
      { id: MAIN_SERVER_ID, name: 'relay', removable: false },
      { id: 'srv', name: 'мой', removable: true },
    ];
    s().setServers(list);
    s().setActiveServer('srv');
    s().setServers(list);
    expect(s().activeServerId).toBe('srv');
  });

  it('разблокировка запоминается один раз и снимает ошибку', () => {
    s().setUnlockError('server.refusal.gone');
    s().markUnlocked('srv');
    s().markUnlocked('srv');
    expect(s().unlockedIds).toEqual(['srv']);
    expect(s().unlockError).toBeNull();
  });

  it('модалка пароля открывается чистой и закрывается полностью', () => {
    s().setUnlockError('server.refusal.gone');
    s().openUnlock('srv');
    expect(s()).toMatchObject({ unlockTargetId: 'srv', unlockError: null });
    s().setUnlockError('server.refusal.gone');
    s().closeUnlock();
    expect(s()).toMatchObject({ unlockTargetId: null, unlockError: null });
  });

  it('доступность сервера: открытый — всем, закрытый — только по паролю', () => {
    expect(isServerUnlocked({ id: 'a' }, [])).toBe(true);
    expect(isServerUnlocked({ id: 'a', locked: true }, [])).toBe(false);
    expect(isServerUnlocked({ id: 'a', locked: true }, ['a'])).toBe(true);
  });
});

describe('реестр каналов', () => {
  it('до первого события виден сид, потом список заменяется целиком', () => {
    expect(useChannelsStore.getState().channels).toEqual(DEFAULT_CHANNELS);
    useChannelsStore.getState().setChannels([]);
    expect(useChannelsStore.getState().channels).toEqual([]);
  });
});

describe('другие хосты', () => {
  const s = () => useHostsStore.getState();

  it('гидрация читает хранилище ровно один раз', () => {
    localStorage.setItem('relay-hosts', JSON.stringify([{ url: 'https://a.example' }]));
    s().hydrate();
    expect(s().hosts).toEqual([{ url: 'https://a.example' }]);
    localStorage.setItem('relay-hosts', JSON.stringify([{ url: 'https://b.example' }]));
    s().hydrate();
    expect(s().hosts).toEqual([{ url: 'https://a.example' }]);
  });

  it('повторное добавление того же origin обновляет подпись, а не двоит строку', () => {
    s().addHost({ url: 'https://a.example' });
    s().addHost({ url: 'https://a.example', label: 'у друга' });
    expect(s().hosts).toEqual([{ url: 'https://a.example', label: 'у друга' }]);
  });

  it('добавленное и удалённое сразу уходит в хранилище', () => {
    s().addHost({ url: 'https://a.example' });
    expect(localStorage.getItem('relay-hosts')).toContain('a.example');
    s().removeHost('https://a.example');
    expect(s().hosts).toEqual([]);
    expect(localStorage.getItem('relay-hosts')).toBe('[]');
  });
});

describe('звук каналов', () => {
  const s = () => useNotifyStore.getState();

  it('по умолчанию молчат все каналы — включают их поимённо', () => {
    expect(isChannelLoud(s(), 'obshchii')).toBe(false);
    expect(s().toggleChannel('obshchii')).toBe(true);
    expect(isChannelLoud(s(), 'obshchii')).toBe(true);
    // Соседний канал включение не задело.
    expect(isChannelLoud(s(), 'flud')).toBe(false);
  });

  it('повторное переключение возвращает канал в молчание', () => {
    s().toggleChannel('obshchii');
    expect(s().toggleChannel('obshchii')).toBe(false);
    expect(s().loud).toEqual([]);
  });

  it('выбор сразу уходит в хранилище', () => {
    s().toggleChannel('obshchii');
    expect(JSON.parse(localStorage.getItem(PREF_STORAGE.sound) || '[]')).toEqual(['obshchii']);
    s().toggleChannel('obshchii');
    expect(localStorage.getItem(PREF_STORAGE.sound)).toBe('[]');
  });

  // Счётчик вспышек к разрешению звука отношения не имеет: гасят звук, не строку.
  it('счётчик вспышек растёт по каналам врозь и мимо localStorage', () => {
    s().notePing('obshchii');
    s().notePing('flud');
    s().notePing('obshchii');
    s().notePing('');
    expect(s().pings).toEqual({ obshchii: 2, flud: 1 });
    expect(localStorage.getItem(PREF_STORAGE.sound)).toBe(null);
  });
});

describe('разблокировка автоплея', () => {
  it('показывается по требованию плитки и снимается по клику', () => {
    expect(useAudioUnlockStore.getState().shown).toBe(false);
    useAudioUnlockStore.getState().show();
    expect(useAudioUnlockStore.getState().shown).toBe(true);
    useAudioUnlockStore.getState().dismiss();
    expect(useAudioUnlockStore.getState().shown).toBe(false);
  });
});
