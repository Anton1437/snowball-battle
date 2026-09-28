// Data-source menu: a pixel popover (wide layout) or bottom sheet (phone) opened from the
// source badge, with a radiogroup of AGG / Binance / Bybit / Coinbase and a small settings
// section (sound, language). The same radio rows are reused for the side-panel venue list.
import { t, formatPriceUsd } from './i18n.js?v=1c0f08fd';
import { SOURCES } from './market/market.js?v=1c0f08fd';

const NAMES = { BINANCE: 'Binance', BYBIT: 'Bybit', COINBASE: 'Coinbase' };

export function createSourceMenu({ market, onSelect, onToggleSound, onToggleLang, isSoundOn }) {
  const root = document.getElementById('source-menu');
  const sheet = root.querySelector('.menu-sheet');
  const list = document.getElementById('menu-sources');
  const soundBtn = document.getElementById('menu-sound');
  const langBtn = document.getElementById('menu-lang');
  const lists = [list];               // radiogroups kept in sync (menu + side panel)
  let anchor = null;
  let refreshTimer = 0;

  const isOpen = () => !root.hidden;

  // ---------- rows ----------
  function rowState(src, venues, liveCount) {
    if (src === 'AGG') {
      return { name: t('menu.agg'), alive: liveCount > 0, meta: t('menu.live', { n: liveCount }) };
    }
    const v = venues[src.toLowerCase()];
    return {
      name: NAMES[src],
      alive: v.alive,
      meta: v.alive ? formatPriceUsd(v.price) : t('menu.offline'),
    };
  }

  function renderList(container) {
    const venues = market.getVenues();
    const liveCount = market.getLiveCount();
    const selected = market.getSelected();
    if (!container.children.length) {
      for (const src of SOURCES) {
        const row = document.createElement('div');
        row.className = 'src-row';
        row.setAttribute('role', 'radio');
        row.dataset.src = src;
        row.innerHTML = '<span class="radio" aria-hidden="true"></span><span class="vdot" aria-hidden="true"></span>'
          + '<span class="src-name"></span><span class="src-meta"></span>';
        container.append(row);
      }
    }
    for (const row of container.children) {
      const src = row.dataset.src;
      const st = rowState(src, venues, liveCount);
      const checked = src === selected;
      const disabled = !st.alive && !checked;
      row.querySelector('.src-name').textContent = st.name;
      row.querySelector('.src-meta').textContent = st.meta;
      row.classList.toggle('down', !st.alive);
      row.setAttribute('aria-checked', String(checked));
      row.setAttribute('aria-disabled', String(disabled));
      row.tabIndex = checked ? 0 : -1; // roving tabindex
    }
  }

  function render() {
    for (const c of lists) renderList(c);
    soundBtn.setAttribute('aria-checked', String(isSoundOn()));
    soundBtn.querySelector('.state').textContent = t(isSoundOn() ? 'menu.on' : 'menu.off');
    langBtn.querySelector('.state').textContent = t('menu.langName');
  }

  function choose(row) {
    if (!row || row.getAttribute('aria-disabled') === 'true') return;
    const src = row.dataset.src;
    if (src !== market.getSelected()) onSelect(src);
    render();
    close();
  }

  // ---------- keyboard (radiogroup pattern) ----------
  function onListKey(e) {
    const rows = [...e.currentTarget.children].filter((r) => r.getAttribute('aria-disabled') !== 'true');
    const i = rows.indexOf(document.activeElement);
    if (e.key === 'ArrowDown' || e.key === 'ArrowRight' || e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
      e.preventDefault();
      const dir = e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : -1;
      rows[(i + dir + rows.length) % rows.length]?.focus();
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      choose(document.activeElement.closest('.src-row'));
    }
  }

  function wireList(container) {
    container.addEventListener('click', (e) => choose(e.target.closest('.src-row')));
    container.addEventListener('keydown', onListKey);
  }
  wireList(list);

  // ---------- open / close ----------
  function position() {
    const phone = document.documentElement.dataset.layout !== 'wide';
    root.classList.toggle('sheet', phone);
    if (phone || !anchor) {
      sheet.style.left = sheet.style.top = '';
      return;
    }
    const r = anchor.getBoundingClientRect();
    const w = sheet.offsetWidth;
    sheet.style.left = `${Math.max(8, Math.min(window.innerWidth - w - 8, r.right - w))}px`;
    sheet.style.top = `${Math.min(window.innerHeight - sheet.offsetHeight - 8, r.bottom + 6)}px`;
  }

  function open(anchorEl) {
    anchor = anchorEl;
    render();
    root.hidden = false;
    position();
    anchor?.setAttribute('aria-expanded', 'true');
    (list.querySelector('[aria-checked="true"]') || list.firstElementChild)?.focus();
    clearInterval(refreshTimer);
    refreshTimer = setInterval(render, 1000); // live dots / prices
  }

  function close() {
    if (!isOpen()) return;
    root.hidden = true;
    clearInterval(refreshTimer);
    anchor?.setAttribute('aria-expanded', 'false');
    anchor?.focus();
  }

  root.querySelector('.menu-backdrop').addEventListener('click', close);
  document.getElementById('menu-close').addEventListener('click', close);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && isOpen()) close(); });
  window.addEventListener('resize', () => { if (isOpen()) position(); });
  soundBtn.addEventListener('click', () => { onToggleSound(); render(); });
  langBtn.addEventListener('click', () => { onToggleLang(); render(); });

  return {
    open,
    close,
    toggle(anchorEl) { if (isOpen()) close(); else open(anchorEl); },
    render,
    get isOpen() { return isOpen(); },
    // Reuse the radio rows elsewhere (side-panel venue list).
    mountList(container) {
      lists.push(container);
      wireList(container);
      renderList(container);
    },
  };
}
