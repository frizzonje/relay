import { expect } from '@playwright/test';
import { connected, joinVoice, person, test, unique } from '../fixtures/stand';

/**
 * Живой разговор двумя браузерами — то единственное, чего до сих пор не
 * проверял ни один спек, хотя дороже него в relay нет ничего.
 *
 * Проверяем не «нажалось», а что соединение и правда встало: метка задержки в
 * панели голоса рисуется по статистике живого `RTCPeerConnection` (см.
 * `voice/mesh/metrics.ts`). Пока пиры не договорились, там `waiting` и
 * никаких миллисекунд — то есть «N ms» у обоих и есть доказательство, что
 * медиаканал открыт, а не что кнопка покрасилась.
 *
 * Микрофон настоящий, но фальшивый: Chromium отдаёт синтетическую дорожку по
 * `--use-fake-device-for-media-stream`, и права выдаёт сам. Без этого браузер
 * встал бы на системном окне доступа, которого в CI некому нажать.
 *
 * Канал берём «P2P общий»: он всегда прямой и работает без поднятого
 * медиасервера, значит спек не зависит от того, есть ли на стенде SFU.
 */

test.use({
  launchOptions: {
    args: [
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      '--autoplay-policy=no-user-gesture-required',
    ],
  },
});

test('двое в канале: соединение встаёт, мут доезжает, уход виден', async ({ browser }) => {
  test.setTimeout(180_000);
  const her = unique('Аня');
  const him = unique('Борис');

  const anya = await person(browser, her, { permissions: ['microphone'] });
  const boris = await person(browser, him, { permissions: ['microphone'] });

  await joinVoice(anya, 'P2P общий', her);
  await joinVoice(boris, 'P2P общий', him);

  // Друг друга видно — плитку заводит транспорт по составу комнаты.
  await expect(anya.getByText(him, { exact: true }).first()).toBeVisible({ timeout: 30_000 });
  await expect(boris.getByText(her, { exact: true }).first()).toBeVisible({ timeout: 30_000 });

  // …и соединение реально установлено: миллисекунды приезжают из getStats
  // живого соединения, метрики снимаются раз в три секунды.
  await connected(anya);
  await connected(boris);

  // Мут едет через presence на сервере, а не по медиаканалу: его видно и тем,
  // кто сам не в эфире.
  await anya.getByRole('button', { name: 'Mute the microphone' }).click();
  await expect(boris.getByRole('img', { name: 'Microphone off' }).first()).toBeVisible({
    timeout: 20_000,
  });

  // Уход снимает плитку сразу, не дожидаясь грейса: тот только для обрывов.
  await anya.getByRole('button', { name: 'Disconnect' }).click();
  await expect(boris.getByText(her, { exact: true })).toHaveCount(0, { timeout: 20_000 });
});
