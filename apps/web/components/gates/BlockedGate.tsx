'use client';

import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { useContractStore } from '@/stores/contract';
import { useT } from '@/lib/i18n';

/**
 * Адрес, с которого пришли, закрыт владельцем инсталляции.
 *
 * Экран, а не полоска, по той же причине, что у бана и обслуживания: сокета
 * после такого отказа нет вовсе, и всё вокруг — каналы, состав, поле ввода —
 * остаётся декорацией, которая молча ничего не делает.
 *
 * Текст свой, не банный, и это решение, а не оформление. За одним адресом
 * сидит подъезд, институт, оператор: попавший под маску мог не делать ничего,
 * а «вас забанили» обвинило бы его в чужом. Поэтому здесь говорится ровно то,
 * что случилось, — закрыт адрес, — и ни слова о человеке.
 *
 * Состояние берётся из стора контракта, а не из настроек: список закрытых
 * адресов клиенту не уезжает вовсе, да и уехать ему некуда — снимок настроек
 * ходит по сокету, которого у отвергнутого как раз и нет.
 *
 * Кнопки «повторить» нет намеренно: клиент стучится сам, и в тот миг, когда
 * владелец снимет маску, экран пропадёт без единого нажатия.
 */
export function BlockedGate() {
  const t = useT();
  const blocked = useContractStore((s) => s.blocked);

  return (
    <Dialog open={blocked}>
      <DialogContent
        className="max-w-[420px]"
        onEscapeKeyDown={(e) => e.preventDefault()}
        onPointerDownOutside={(e) => e.preventDefault()}
        onInteractOutside={(e) => e.preventDefault()}
      >
        <div className="px-7 pb-6 pt-6 text-center">
          <div className="mx-auto mb-3 grid h-12 w-12 place-items-center rounded-2xl bg-bg-deep text-2xl">
            🚧
          </div>
          <DialogTitle className="text-xl">{t('blocked.title')}</DialogTitle>
          <DialogDescription
            className="mx-auto mt-1.5 max-w-[320px] text-[13px] leading-relaxed"
            data-testid="blocked-message"
          >
            {t('blocked.body')}
          </DialogDescription>
        </div>
      </DialogContent>
    </Dialog>
  );
}
