import { create } from 'zustand';
import type { ChannelType } from '@relay/shared';
import { tx } from '@/lib/i18n';

/**
 * UI-стор каркаса. Голос и текст — независимые подключения; `view` — лишь то,
 * что показано на экране. Открытие текстового канала не трогает голос и
 * наоборот. Сокет-эффекты (chat-join/leave) навешаны на изменения `textRoom`
 * в SocketProvider — стор остаётся «чистым».
 */
export type ShellView = 'lobby' | 'voice' | 'text';

/**
 * Сцена — то, что показано в середине экрана: вид и, для текста, какой именно
 * канал. Два текстовых канала — две РАЗНЫЕ сцены: смена одного на другой такая
 * же смена картинки, как выход из лобби в канал, и выглядеть должна так же.
 */
export interface Scene {
  view: ShellView;
  textRoom: string | null;
  textLabel: string;
}

/** Та же сцена? Подпись не в счёт: это надпись на сцене, а не сама сцена. */
function sameScene(a: Scene, b: Scene): boolean {
  return a.view === b.view && a.textRoom === b.textRoom;
}

/** Кто ждёт, пока отложенный переход доедет до экрана (см. `sceneSettled`). */
let settleWaiters: Array<() => void> = [];

function settle() {
  const waiting = settleWaiters;
  settleWaiters = [];
  waiting.forEach((resolve) => resolve());
}

/**
 * Активная мобильная панель. На узком экране колонки десктопа (рейка+сайдбар /
 * сцена / состав) не помещаются рядом — показываем по одной, переключение снизу
 * таб-баром. На десктопе (`md:`) значение игнорируется: видны все колонки сразу.
 */
export type MobilePanel = 'nav' | 'stage' | 'people';

interface UiState {
  /**
   * Вид, КОТОРЫЙ НА ЭКРАНЕ (вместе с `textRoom`/`textLabel` — сцена целиком).
   * Пока прежняя сцена гаснет, поля сцены держат именно её: под ними и лента
   * прежнего канала, и колонка состава, и подпись в шапке. Гасить сцену,
   * содержимое которой уже подменили, значит гасить пустоту — потому переход
   * и приезжает сюда не раньше, чем ей найдётся смена (см. `pendingScene`).
   */
  view: ShellView;
  textRoom: string | null;
  textLabel: string;
  /**
   * Куда идём, пока прежняя сцена гаснет; `null` — стоим на месте. Применяет
   * его сама сцена, когда догасла (`commitScene` из Stage/ChatPanel), — а не
   * таймер той же длины: рядом со сменой канала главный поток бывает занят на
   * сотни миллисекунд, и таймер в этот момент срабатывает не тогда же, когда
   * идёт анимация.
   */
  pendingScene: Scene | null;
  /**
   * Есть ли на экране сцена, которой гаснуть. Откладывать переход имеет смысл
   * ровно ради её анимации: без сцены (тесты, экран входа) идём сразу, иначе
   * переход повис бы навсегда — гасить нечего, значит и досказать «догасла»
   * некому.
   */
  stageLive: boolean;
  setStageLive: (live: boolean) => void;
  /** Общий вход для всех переходов между сценами. */
  goScene: (next: Scene) => void;
  /** Прежняя сцена догасла — показываем следующую. Зовут Stage и ChatPanel. */
  commitScene: () => void;
  /**
   * Дождаться, пока переход доедет до экрана. Нужен тем, у кого сразу за
   * переходом идёт разговор с сервером: сокет входит в новый канал вместе со
   * сценой, а не в момент клика (см. поиск).
   */
  sceneSettled: () => Promise<void>;
  voiceRoom: string | null;
  voiceLabel: string;
  /** Тег пользователя (myName). Меняется только пока ты нигде не подключён. */
  callsign: string;
  setCallsign: (name: string) => void;
  /** Модалка создания направления — общая для рейки и сайдбара. */
  createChannelOpen: boolean;
  createChannelType: ChannelType;
  openCreateChannel: (type: ChannelType) => void;
  setCreateChannelOpen: (open: boolean) => void;
  /** Какая панель открыта на мобиле (см. MobilePanel). */
  mobilePanel: MobilePanel;
  setMobilePanel: (panel: MobilePanel) => void;
  /** Окно настроек. В сторе, а не в рейке: открывается ещё и из ПКМ-меню. */
  settingsOpen: boolean;
  setSettingsOpen: (open: boolean) => void;
  openText: (slug: string, label: string) => void;
  /** Закрыть текстовый канал: уходим к сетке (если в голосе) или в лобби. */
  leaveText: () => void;
  openVoice: (room: string, label: string) => void;
  /** Вышли из эфира: показываем открытый текстовый канал или лобби. */
  clearVoice: () => void;
  goLobby: () => void;
}

export const useUiStore = create<UiState>((set, get) => ({
  view: 'lobby',
  textRoom: null,
  textLabel: '',
  pendingScene: null,
  stageLive: false,
  setStageLive: (live) => set({ stageLive: live }),
  goScene: (next) => {
    const now = get();
    // Та же сцена (сменилась только подпись) или гаснуть нечему — меняем сразу.
    if (!now.stageLive || sameScene(now, next)) {
      set({ ...next, pendingScene: null });
      settle();
      return;
    }
    set({ pendingScene: next });
  },
  commitScene: () => {
    const next = get().pendingScene;
    if (!next) return;
    set({ ...next, pendingScene: null });
    settle();
  },
  sceneSettled: () =>
    get().pendingScene
      ? new Promise<void>((resolve) => settleWaiters.push(resolve))
      : Promise.resolve(),
  voiceRoom: null,
  voiceLabel: '',
  callsign: '',
  setCallsign: (name) => set({ callsign: name }),
  createChannelOpen: false,
  createChannelType: 'voice',
  openCreateChannel: (type) => set({ createChannelType: type, createChannelOpen: true }),
  setCreateChannelOpen: (open) => set({ createChannelOpen: open }),
  // Стартуем со списка каналов — как в мобильном Discord: сперва выбор, потом сцена.
  mobilePanel: 'nav',
  setMobilePanel: (panel) => set({ mobilePanel: panel }),
  settingsOpen: false,
  setSettingsOpen: (open) => set({ settingsOpen: open }),
  // mobilePanel здесь же: открыть канал — значит смотреть его. Без этого тап по
  // уже открытому каналу на мобиле не делал ничего (состояние не менялось —
  // значит, и переключать панель было некому), и с экрана каналов было не
  // вернуться в ленту. На десктопе поле игнорируется. Панель переключаем сразу,
  // не дожидаясь сцены: она и есть ответ на тап, ждать его человек не должен.
  openText: (slug, label) => {
    set({ mobilePanel: 'stage' });
    get().goScene({ view: 'text', textRoom: slug, textLabel: label });
  },
  leaveText: () =>
    get().goScene({ view: get().voiceRoom ? 'voice' : 'lobby', textRoom: null, textLabel: '' }),
  openVoice: (room, label) => {
    set({ voiceRoom: room, voiceLabel: label, mobilePanel: 'stage' });
    const { textRoom, textLabel } = sceneTarget(get());
    get().goScene({ view: 'voice', textRoom, textLabel });
  },
  clearVoice: () => {
    set({ voiceRoom: null, voiceLabel: '' });
    const { textRoom, textLabel } = sceneTarget(get());
    get().goScene({ view: textRoom ? 'text' : 'lobby', textRoom, textLabel });
  },
  goLobby: () => {
    const { textRoom, textLabel } = sceneTarget(get());
    get().goScene({ view: 'lobby', textRoom, textLabel });
  },
}));

/**
 * Сцена, к которой мы идём (или та, что на экране, если переход не начат).
 * По ней отвечают на вопрос «где я сейчас» те, кому ждать нельзя: подсветка
 * строки в списке каналов должна отзываться на клик, а не на анимацию.
 */
export function sceneTarget(s: UiState): Scene {
  return s.pendingScene ?? { view: s.view, textRoom: s.textRoom, textLabel: s.textLabel };
}

/** Вид, к которому мы идём. Селектор отдаёт примитив — так его любит zustand. */
export const targetView = (s: UiState): ShellView => sceneTarget(s).view;

/** Текстовый канал, к которому мы идём (`null` — уходим из текста). */
export const targetRoom = (s: UiState): string | null => sceneTarget(s).textRoom;

/** Имя для сокета/чата — пустой тег превращаем в «Аноним» (как myName()). */
export function myName(): string {
  return useUiStore.getState().callsign.trim() || tx('common.anonymous');
}
