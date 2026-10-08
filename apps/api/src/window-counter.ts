/**
 * Счётчик событий в окне — «сколько раз за последние N» по ключу (адрес,
 * личность). Окно открывает первое событие и закрывает срок: после него счёт
 * начинается заново. Один расчёт на все такие счётчики api — неудачные
 * пароли, попытки входа в минуту, промахи по коду связки; что считать и
 * когда отказывать, решает владелец.
 *
 * Своего таймера у счётчика нет: протухшие записи убираются, когда карта
 * разрастается сверх `maxTracked` (иначе она росла бы на каждый новый ключ до
 * конца жизни процесса), а владелец с собственной уборкой зовёт `forgetExpired`.
 */
export class WindowCounter {
  private readonly entries = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly windowMs: number,
    private readonly maxTracked = 10_000,
  ) {}

  /** Счёт в живом окне; ноль — окна нет или оно закрылось. */
  count(key: string, now = Date.now()): number {
    const entry = this.entries.get(key);
    if (!entry) return 0;
    if (now > entry.resetAt) {
      this.entries.delete(key);
      return 0;
    }
    return entry.count;
  }

  /** Отметить событие. Возвращает счёт вместе с ним. */
  hit(key: string, now = Date.now()): number {
    const entry = this.entries.get(key);
    if (!entry || now > entry.resetAt) {
      this.entries.set(key, { count: 1, resetAt: now + this.windowMs });
      if (this.entries.size > this.maxTracked) this.forgetExpired(now);
      return 1;
    }
    entry.count += 1;
    return entry.count;
  }

  /** Забыть ключ: счёт снят (успешный вход). */
  clear(key: string): void {
    this.entries.delete(key);
  }

  forgetExpired(now = Date.now()): void {
    for (const [key, entry] of this.entries) if (now > entry.resetAt) this.entries.delete(key);
  }
}
