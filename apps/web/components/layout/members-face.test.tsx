// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Members } from './Members';
import { useUiStore } from '@/stores/ui';
import { useVoiceStore, type VoiceTile } from '@/stores/voice';

/**
 * Голосовой канал показывает лицо человека, а не картинку по имени, и лицо
 * отзывается на его голос само — без кольца вокруг. Ради этого отпечаток и
 * едет до плитки, и проверять надо именно дорогу: из стора в разметку лица.
 *
 * Что именно тут ловится: если `speaking` перестанет доезжать до `<Identicon>`
 * (или доедет всем сразу), состав канала останется на вид правильным — имена,
 * подписи, зелёные точки на местах, — и заметить это можно будет только на
 * живом звонке. Поэтому проверка смотрит на класс, которым речь зажигает
 * поясам кадры (см. lib/identicon: разметка лица от речи не зависит).
 */

const tile = (over: Partial<VoiceTile>): VoiceTile => ({
  id: 'peer-1',
  name: 'Борис',
  stream: null,
  state: '',
  isLocal: false,
  screen: false,
  fingerprint: '6668-7aad-f862-bd77',
  ...over,
});

/**
 * Рисуем по-настоящему, в DOM, а не в строку сервером: на сервере zustand
 * отдаёт компонентам НАЧАЛЬНОЕ состояние (иначе гидратация ловила бы
 * расхождение), и разложенный тестом стор до разметки бы не доехал.
 */
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

function markup(): string {
  act(() => root.render(<Members />));
  return host.innerHTML;
}

describe('лицо в составе голосового канала', () => {
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    useUiStore.setState({ view: 'voice' });
    useVoiceStore.setState({ tiles: [], speakingIds: [], micOn: true, myId: null });
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it('рисуется из отпечатка, а не из имени', () => {
    useVoiceStore.setState({ tiles: [tile({})] });
    expect(markup()).toContain('rl-identicon');
  });

  it('молчащий — только дрейф, поясам кадров не дано', () => {
    useVoiceStore.setState({ tiles: [tile({})] });
    const out = markup();
    expect(out).toContain('rlDrift');
    expect(out).not.toContain('rl-identicon-speaking');
  });

  it('говорящий — поле бьётся поясами', () => {
    useVoiceStore.setState({ tiles: [tile({})], speakingIds: ['peer-1'] });
    expect(markup()).toContain('rl-identicon-speaking');
  });

  it('речь не переписывает саму картинку', () => {
    // Иначе дрейф начинался бы заново на каждое «заговорил» — по нескольку раз
    // в минуту и ровно тогда, когда на лицо смотрят.
    useVoiceStore.setState({ tiles: [tile({})] });
    markup();
    const face = host.querySelector('.rl-identicon')!;
    const quiet = face.innerHTML;
    useVoiceStore.setState({ speakingIds: ['peer-1'] });
    markup();
    // Тот же самый узел, и содержимое его React не тронул — только класс.
    expect(host.querySelector('.rl-identicon')).toBe(face);
    expect(face.innerHTML).toBe(quiet);
    expect(face.className).toContain('rl-identicon-speaking');
  });

  it('бьётся лицо говорящего, а не всех подряд', () => {
    // Список говорящих приходит по id плиток. Перепутать «кто именно» здесь
    // легко и незаметно: на глаз разница видна только вживую.
    useVoiceStore.setState({
      tiles: [tile({}), tile({ id: 'peer-2', name: 'Вера', fingerprint: '16cc-cc1a-be5a-3301' })],
      speakingIds: ['peer-2'],
    });
    expect(markup().split('rl-identicon-speaking').length - 1).toBe(1);
  });

  it('своя плитка отзывается на «local», а не на socket-id', () => {
    // Себя менеджер зовёт 'local' — своей плитки под настоящим id не бывает.
    useVoiceStore.setState({
      tiles: [tile({ id: 'local', name: 'Аня', isLocal: true })],
      speakingIds: ['local'],
    });
    expect(markup()).toContain('rl-identicon-speaking');
  });

  it('гостю без ключа остаётся картинка по имени', () => {
    // Отпечатка ему не выдавали, и рисовать «лицо ключа» там, где ключа нет,
    // значило бы обещать узнаваемость, которой неоткуда взяться.
    useVoiceStore.setState({ tiles: [tile({ fingerprint: undefined, guest: true })] });
    expect(markup()).not.toContain('rl-identicon');
  });
});
