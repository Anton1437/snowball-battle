// «Правила» (v1.084): the full rules screen, opened from the settings sheet. Collapsible
// <details> chapters (reusing the same accordion the wardrobe uses) plus a short FAQ. Static
// text per language; rebuilt only on open() and on a language change, never on a timer.
import { t } from './i18n.js?v=0d20a97d';
import { backButton } from './tg.js?v=0d20a97d';

const $ = (id) => document.getElementById(id);
const CHAPTERS = ['field', 'rounds', 'forecasts', 'side', 'duels', 'progress', 'fair'];
const FAQ_N = 8;

export function createRulesSheet() {
  const root = $('rules-sheet');
  if (!root) return { open() {}, relabel() {} };
  const body = $('rules-body');
  const panel = root.querySelector('.rules-panel');

  function chapterHtml(key) {
    const lines = [];
    for (let i = 1; ; i++) {
      const k = `rules.${key}.l${i}`;
      const s = t(k);
      if (s === k) break;
      lines.push(`<p>${s}</p>`);
    }
    return `<details><summary>${t(`rules.${key}.title`)}</summary>${lines.join('')}</details>`;
  }

  function faqHtml() {
    const rows = [];
    for (let i = 1; i <= FAQ_N; i++) {
      const qk = `rules.faq.q${i}`;
      const q = t(qk);
      if (q === qk) continue;
      rows.push(`<dt>${q}</dt><dd>${t(`rules.faq.a${i}`)}</dd>`);
    }
    return `<h3 class="menu-sub">${t('rules.faqTitle')}</h3><dl class="rules-faq">${rows.join('')}</dl>`;
  }

  function render() {
    body.innerHTML = `${CHAPTERS.map(chapterHtml).join('')}${faqHtml()}`;
  }

  const isOpen = () => !root.hidden;

  function open() {
    render();
    root.classList.toggle('sheet', document.documentElement.dataset.layout !== 'wide');
    root.hidden = false;
    backButton(true, close);
    panel.scrollTop = 0;
  }
  function close() {
    if (!isOpen()) return;
    root.hidden = true;
    backButton(false, close);
  }
  root.querySelector('.menu-backdrop').addEventListener('click', close);
  $('rules-close').addEventListener('click', close);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && isOpen()) close(); });

  return {
    open,
    close,
    relabel() { if (isOpen()) render(); },
    get isOpen() { return isOpen(); },
  };
}
