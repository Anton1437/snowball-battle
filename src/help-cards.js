// Contextual "?" help (v1.084): one shared card, opened from 4 small "?" buttons (forecast bar,
// duel entry, wardrobe header, profile header). Each topic is a pixel illustration (real sprite
// icons), a title, a few short lines and one concrete example. Built once; content is swapped in
// place, never rebuilt — same pattern as the tutorial cards.
import { t } from './i18n.js?v=461444cd';
import { spriteDataUrl } from './game/sprites-cache.js?v=461444cd';
import { backButton } from './tg.js?v=461444cd';

const $ = (id) => document.getElementById(id);

const TOPICS = {
  forecast: { icons: [['icon_head_back', 'green', 2], ['icon_head_front', 'red', 2], ['icon_bolt', 'green', 2]], lines: 4 },
  duel: { icons: [['ball_small', 'green', 2], ['giant_back_idle', 'green', 1]], lines: 4 },
  wardrobe: { icons: [['icon_head_back', 'green', 2], ['crown', 'green', 2]], lines: 4 },
  profile: { icons: [['ach_calendar', 'green', 2], ['flag_team', 'green', 2]], lines: 4 },
};

export function createHelpCards() {
  const root = $('help-card');
  if (!root) return { open() {}, relabel() {} };
  const icons = $('help-card-icons');
  const title = $('help-card-title');
  const body = $('help-card-body');
  const example = $('help-card-example');
  let topic = null;

  function render() {
    if (!topic) return;
    const def = TOPICS[topic];
    icons.innerHTML = def.icons.map(([name, team, scale]) =>
      `<img class="px-icon" src="${spriteDataUrl(name, team, scale)}" alt="">`).join('');
    title.textContent = t(`help.${topic}.title`);
    const rows = [];
    for (let i = 1; i <= def.lines; i++) rows.push(`<li>${t(`help.${topic}.l${i}`)}</li>`);
    body.innerHTML = `<ul class="help-lines">${rows.join('')}</ul>`;
    example.innerHTML = `<b>${t('help.example')}</b> ${t(`help.${topic}.example`)}`;
  }

  function open(key) {
    if (!TOPICS[key]) return;
    topic = key;
    render();
    root.classList.toggle('sheet', document.documentElement.dataset.layout !== 'wide');
    root.hidden = false;
    backButton(true, close);
  }
  function close() {
    if (root.hidden) return;
    root.hidden = true;
    backButton(false, close);
  }
  root.querySelector('.menu-backdrop').addEventListener('click', close);
  $('help-card-close').addEventListener('click', close);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !root.hidden) close(); });

  for (const btn of document.querySelectorAll('[data-help]')) {
    btn.addEventListener('click', () => open(btn.dataset.help));
  }

  return {
    open,
    close,
    relabel() { if (!root.hidden) render(); },
  };
}
