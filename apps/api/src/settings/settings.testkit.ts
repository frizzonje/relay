import type { DataSource } from 'typeorm';
import { SettingsService } from './settings.service';

/**
 * Настройки для теста — настоящие и на настоящей базе.
 *
 * Свежий сервис на пустой таблице (после `resetDatabase`) — это «инсталляция,
 * где панель не открывали ни разу»: переопределений нет, и каждый ответ равен
 * умолчанию каталога, то есть поведению relay до этапа C. Тест, который ничего
 * не настраивал, обязан этой разницы не заметить — в этом и весь смысл.
 *
 * Подделку сюда подставлять нельзя: она отвечала бы придуманным значением на
 * ключ, которого в каталоге нет, и опечатка в имени параметра прошла бы мимо.
 */
export async function freshSettings(db: DataSource): Promise<SettingsService> {
  const settings = new SettingsService(db);
  await settings.onModuleInit();
  return settings;
}

/**
 * Кем тест подписывает правку настройки. В жизни это личность владельца; здесь
 * достаточно её вида — колонка хранит uuid и ничего о нём не спрашивает, а
 * проверяем мы действие параметра, а не авторство.
 */
const PANEL_ACTOR = '00000000-0000-4000-8000-000000000001';

/**
 * Открыть панель и поменять параметр. Отказ поднимается исключением НАРОЧНО:
 * опечатка в ключе иначе прошла бы тихо, тест остался бы зелёным и проверял бы
 * поведение с умолчанием — то есть ровно ничего.
 */
export async function tune(settings: SettingsService, key: string, value: unknown): Promise<void> {
  const res = await settings.set(key, value, PANEL_ACTOR);
  if (!res.ok) throw new Error(`настройку ${key} не приняли: ${res.error}`);
}
