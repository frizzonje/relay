import type { Logger } from '@nestjs/common';
import type { SettingsService } from './settings/settings.service';

/**
 * Работа по расписанию — уборка истории, личностей, файлов. Одна на всех,
 * потому что у всех три одинаковых обязательства, и раньше каждый уборщик
 * выполнял их сам — то есть не выполнял.
 *
 * 1. **Проход за проходом, не внахлёст.** `setInterval` не ждёт обещания:
 *    DELETE по большой таблице дольше периода (у «не хранить» он минута) — и
 *    следующий проход стартует поверх идущего, деля с ним те же строки.
 * 2. **Ошибка прохода — в лог, а не в процесс.** Таймер зовёт задачу без
 *    `await`, и её отказ — необработанный: Node 20 на нём падает. Перезапуск
 *    Postgres посреди уборки ронял бы api со всеми сокетами и звонками.
 * 3. **Расписание снимается вместе с владельцем** (`stop` в его
 *    `onModuleDestroy`), а не живёт до конца процесса.
 */
export class Periodic {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private unfollow: (() => void) | null = null;

  constructor(
    private readonly logger: Logger,
    private readonly task: () => Promise<unknown>,
  ) {}

  /**
   * Расписание, которое следует за настройками. `plan` зовётся на старте и на
   * каждой смене любого из `keys` и отвечает периодом — или `null`, если не
   * ходить вовсе.
   *
   * Настройка, которая начинает действовать только после перезапуска, — не
   * настройка: человек, поставивший в панели три дня, ждёт, что недельное
   * уйдёт сегодня, а не с ближайшим обновлением образа. И наоборот: включив
   * уборку, он остался бы без единого прохода, потому что у выключенной
   * таймера нет вовсе.
   */
  follow(settings: SettingsService, keys: readonly string[], plan: () => number | null): void {
    const apply = () => {
      const ms = plan();
      if (ms === null) this.halt();
      else this.every(ms);
    };
    apply();
    this.unfollow = settings.onChange((key) => {
      if (keys.includes(key)) apply();
    });
  }

  /** Пройти сейчас и дальше каждые `ms`. Прежнее расписание снимается. */
  every(ms: number): void {
    this.halt();
    this.run();
    this.timer = setInterval(() => this.run(), ms);
    // Не держим процесс живым ради уборщика.
    this.timer.unref?.();
  }

  /** Снять расписание и подписку на настройки. */
  stop(): void {
    this.halt();
    this.unfollow?.();
    this.unfollow = null;
  }

  private halt(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private run(): void {
    if (this.running) return;
    this.running = true;
    this.task()
      .catch((e: unknown) => {
        this.logger.error(`проход не удался: ${e instanceof Error ? e.message : String(e)}`);
      })
      .finally(() => {
        this.running = false;
      });
  }
}
