import type { DeviceFailure } from '@/lib/devices';
import type { MessageKey } from '@/lib/i18n';

/**
 * Отказ → строка для человека. Живёт отдельно от экранов, потому что экранов
 * три (просьба, впуск, список), а причины у них общие, и разъехавшиеся
 * формулировки одного и того же отказа читаются как разные беды.
 *
 * Таблица, а не `` `pair.fail.${reason}` ``: собранный из кусков ключ
 * компилятор не проверяет, и забытая строка вылезла бы у человека сырым
 * `pair.fail.self` на экране.
 */
const TEXT: Record<DeviceFailure, MessageKey> = {
  'has-history': 'pair.fail.hasHistory',
  'bad-code': 'pair.fail.badCode',
  'too-many': 'pair.fail.tooMany',
  'bad-signature': 'pair.fail.badSignature',
  self: 'pair.fail.self',
  current: 'pair.fail.current',
  unknown: 'pair.fail.unknown',
  signer: 'pair.fail.signer',
  network: 'pair.fail.network',
};

export function failureText(reason: DeviceFailure): MessageKey {
  return TEXT[reason];
}
