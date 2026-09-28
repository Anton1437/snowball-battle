// First-launch tutorial: 3 pixel cards (field · predictions · side of the day), swipe or
// Next, skippable, shown once (flag in localStorage + the progress profile so it also
// follows the Telegram account). Replay from the settings sheet ("?").
import { t } from './i18n.js?v=0d20a97d';
import { spriteDataUrl } from './game/sprites-cache.js?v=0d20a97d';
import { backButton } from './tg.js?v=0d20a97d';

const SEEN_KEY = 'sb.tut.v1';
const SWIPE_PX = 40;

export function createTutorial({ store }) {
  const root = document.getElementById('tutorial');
  const cards = [...root.querySelectorAll('.tut-card')];
  const dots = [...root.querySelectorAll('#tut-dots i')];
  const next = document.getElementById('tut-next');
  const skip = document.getElementById('tut-skip');
  let index = 0;
  let startX = null;

  for (const box of root.querySelectorAll('[data-icons]')) {
    for (const spec of box.dataset.icons.split(',')) {
      const [name, team, scale] = spec.split(':');
      const img = new Image();
      img.className = 'px-icon';
      img.alt = '';
      img.src = spriteDataUrl(name, team, Number(scale));
      box.append(img);
    }
  }

  const seen = () => {
    try { if (localStorage.getItem(SEEN_KEY) === '1') return true; } catch { /* ignore */ }
    return store?.state?.tu === 1;
  };

  function show(i) {
    index = Math.max(0, Math.min(cards.length - 1, i));
    cards.forEach((c, k) => { c.hidden = k !== index; });
    dots.forEach((d, k) => d.classList.toggle('on', k === index));
    next.textContent = t(index === cards.length - 1 ? 'tut.done' : 'tut.next');
  }

  function open() {
    show(0);
    root.hidden = false;
    backButton(true, close);
    next.focus();
  }

  function close() {
    if (root.hidden) return;
    root.hidden = true;
    backButton(false, close);
    try { localStorage.setItem(SEEN_KEY, '1'); } catch { /* ignore */ }
    if (store && store.state.tu !== 1) {
      store.state.tu = 1;
      store.markDirty();
    }
  }

  next.addEventListener('click', () => (index === cards.length - 1 ? close() : show(index + 1)));
  skip.addEventListener('click', close);
  root.querySelector('.menu-backdrop').addEventListener('click', close);
  document.addEventListener('keydown', (e) => {
    if (root.hidden) return;
    if (e.key === 'Escape') close();
    else if (e.key === 'ArrowRight') show(index + 1);
    else if (e.key === 'ArrowLeft') show(index - 1);
  });
  const sheet = root.querySelector('.tut-sheet');
  sheet.addEventListener('pointerdown', (e) => { startX = e.clientX; });
  sheet.addEventListener('pointerup', (e) => {
    if (startX == null) return;
    const dx = e.clientX - startX;
    startX = null;
    if (Math.abs(dx) >= SWIPE_PX) show(index + (dx < 0 ? 1 : -1));
  });

  return {
    open,
    close,
    maybeShowFirstRun() { if (!seen()) open(); },
    relabel() { if (!root.hidden) show(index); },
    get isOpen() { return !root.hidden; },
  };
}
