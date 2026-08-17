'use client';

import { useState } from 'react';
import { Icon } from '@/components/ui/icon';
import { readPref, setPref } from '@/lib/prefs';
import { useT } from '@/lib/i18n';
import { useChannelsStore } from '@/stores/channels';
import { useIdentityStore } from '@/stores/identity';
import { useNotifyStore } from '@/stores/notify';

/**
 * Что относится к человеку, а что к этому устройству — и где это увидеть.
 *
 * Раздел существует ровно потому, что настройки разъехались по двум местам, и
 * человек имеет право знать, по каким. Звук канала и выкрученная кому-то
 * громкость едут с личностью: включил на десктопе — включено и на телефоне.
 * Микрофон, наушники, горячие клавиши остаются здесь: они про эту машину.
 *
 * Здесь же — единственное место, где общие настройки видно списком. Звук
 * канала включается в меню самого канала, и без этого экрана «а какие каналы у
 * меня звенят?» оставалось бы вопросом без ответа: их пришлось бы обходить
 * поштучно.
 */
export function PersonalPanel() {
  const t = useT();
  const me = useIdentityStore((s) => s.me);
  const loud = useNotifyStore((s) => s.loud);
  const toggleChannel = useNotifyStore((s) => s.toggleChannel);
  const channels = useChannelsStore((s) => s.channels);
  // Громкости живут не в сторе, а в настройках (их читает микшер по ходу
  // звонка) — держим здесь свой счётчик, чтобы кнопка «сбросить» не врала.
  const [volumes, setVolumes] = useState(() => Object.keys(readPref('volume', {})).length);

  const loudChannels = channels.filter((c) => c.type === 'text' && loud.includes(c.slug));

  return (
    <div className="flex flex-col gap-5">
      <p className="text-[12.5px] leading-relaxed text-text-muted">
        {me ? t('personal.intro') : t('personal.intro.noIdentity')}
      </p>

      <section className="flex flex-col gap-2">
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.1em] text-text-muted">
          {t('personal.sound')}
        </h3>
        {loudChannels.length === 0 ? (
          <p className="text-[13px] text-text-muted">{t('personal.sound.empty')}</p>
        ) : (
          loudChannels.map((c) => (
            <div
              key={c.slug}
              className="flex items-center gap-2 rounded-[10px] border border-line bg-bg-elev/60 px-3.5 py-2.5"
            >
              <Icon name="volume-2" className="shrink-0 text-[16px] text-text-muted" />
              <span className="min-w-0 flex-1 truncate text-[14px] text-text-header">
                #{c.name}
              </span>
              <button
                type="button"
                onClick={() => toggleChannel(c.slug)}
                aria-label={t('personal.sound.off')}
                title={t('personal.sound.off')}
                className="shrink-0 rounded-[8px] px-2 py-1.5 text-text-muted outline-none transition-colors hover:bg-bg-deep hover:text-text-header"
              >
                <Icon name="volume-x" className="text-[17px]" />
              </button>
            </div>
          ))
        )}
      </section>

      <section className="flex flex-col gap-2">
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.1em] text-text-muted">
          {t('personal.volume')}
        </h3>
        <p className="text-[13px] text-text-muted">
          {volumes ? t('personal.volume.count', { count: volumes }) : t('personal.volume.empty')}
        </p>
        {volumes > 0 && (
          <button
            type="button"
            onClick={() => {
              setPref('volume', {});
              setVolumes(0);
            }}
            className="self-start rounded-[8px] border border-line px-3 py-1.5 text-[13px] text-text-muted outline-none transition-colors hover:bg-bg-deep hover:text-text-header"
          >
            {t('personal.volume.reset')}
          </button>
        )}
      </section>

      {/* Про конфликт сказано прямо: слить два списка нечем, кроме как выбрать
          один, и человек имеет право знать, какой именно. */}
      <p className="text-[12px] leading-relaxed text-text-muted">{t('personal.conflict')}</p>
    </div>
  );
}
