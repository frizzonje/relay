'use strict';

// Логика окна выбора источника. Язык — как у остального клиента: en база, ru
// перевод по языку системы (navigator.language приходит из настроек ОС).

const RU = {
  title: 'Демонстрация экрана',
  hint: 'Выбранное увидят все, кто сейчас в звонке.',
  screens: 'Экраны',
  windows: 'Окна',
  cancel: 'Отмена',
  empty: 'Источников не нашлось.',
};

const ru = navigator.language.toLowerCase().startsWith('ru');
const t = (key, fallback) => (ru ? RU[key] : fallback);

document.getElementById('title').textContent = t('title', 'Share your screen');
document.getElementById('hint').textContent = t(
  'hint',
  'relay will show the selected source to everyone in the call.',
);
document.getElementById('tab-screen').textContent = t('screens', 'Screens');
document.getElementById('tab-window').textContent = t('windows', 'Windows');
document.getElementById('cancel').textContent = t('cancel', 'Cancel');

const list = document.getElementById('list');
let sources = [];
let kind = 'screen';

function render() {
  list.textContent = '';
  const shown = sources.filter((s) => s.kind === kind);
  if (shown.length === 0) {
    const empty = document.createElement('div');
    empty.id = 'empty';
    empty.textContent = t('empty', 'Nothing to share here.');
    list.append(empty);
    return;
  }
  for (const source of shown) {
    const card = document.createElement('button');
    card.className = 'card';
    const img = document.createElement('img');
    img.src = source.thumbnail;
    img.alt = '';
    const name = document.createElement('span');
    name.textContent = source.name;
    card.append(img, name);
    // Наружу отдаём только id и имя: превью весит мегабайты и там не нужно.
    card.addEventListener('click', () =>
      window.screenPicker.choose({ id: source.id, name: source.name }),
    );
    list.append(card);
  }
}

for (const tab of document.querySelectorAll('.tab')) {
  tab.addEventListener('click', () => {
    kind = tab.dataset.kind;
    for (const other of document.querySelectorAll('.tab')) {
      other.setAttribute('aria-selected', String(other === tab));
    }
    render();
  });
}

document.getElementById('cancel').addEventListener('click', () => window.screenPicker.cancel());
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') window.screenPicker.cancel();
});

window.screenPicker.sources().then((found) => {
  sources = found;
  // Открываемся на той вкладке, где что-то есть: на машине без окон-кандидатов
  // пустой список выглядит как поломка.
  if (!sources.some((s) => s.kind === 'screen') && sources.some((s) => s.kind === 'window')) {
    document.getElementById('tab-window').click();
  } else {
    render();
  }
});
