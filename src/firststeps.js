// «Первые шаги» (v1.084): a 5-step onboarding quest. Each step is completed by DOING the real
// thing live (never DEMO/test params, same "enabled" gate as the rest of progress): pick the
// side of the day, make a round guess, make a candle forecast, play a duel (practice counts),
// equip a wardrobe item. Each step gives +15 XP once, via tracker.addXp() with no bucket — the
// same one-off path achievements use, so it never touches the daily XP caps. Completing all 5
// unlocks the 'first_steps' achievement (progress/achievements.js) — a small badge, the existing
// achievement/item pattern.
//
// Storage: optional profile field `fs = [stepMask, hidden]` (progress/store.js). Upgrading
// players get their already-done steps inferred once from existing counters, WITHOUT XP (same
// precedent as cosmetics.js's `ensureSeen`) — so a veteran doesn't see "0/5" or farm free XP.
//
// UI: a compact HUD pill ("Первые шаги 2/5"); tapping it opens a sheet with all 5 steps, each
// with a one-line how-to and a "Показать" button that jumps to the relevant UI. The pill hides
// forever once all 5 are done or after a "Скрыть" tap. Built once; content is rewritten (not
// rebuilt node-by-node) only on open/store-change, never on a timer.
import { t } from './i18n.js?v=461444cd';
import { spriteDataUrl } from './game/sprites-cache.js?v=461444cd';
import { backButton, hapticSelection } from './tg.js?v=461444cd';

const $ = (id) => document.getElementById(id);
const XP_PER_STEP = 15;
const ALL_MASK = 0b11111;

export const STEPS = [
  { key: 'side', icon: ['flag_team', 'green', 2] },
  { key: 'guess', icon: ['ball_big', 'green', 2] },
  { key: 'forecast', icon: ['icon_bolt', 'green', 2] },
  { key: 'duel', icon: ['ball_small', 'green', 2] },
  { key: 'wardrobe', icon: ['icon_head_back', 'green', 2] },
];

function popcount(n) {
  let c = 0;
  for (let x = n; x; x &= x - 1) c++;
  return c;
}

// Infer already-done steps from existing counters (upgrading players only, no XP awarded).
function inferMask(q) {
  let m = 0;
  if (q.sd) m |= 1 << 0;
  if (q.g[0] >= 1) m |= 1 << 1;
  if (q.f.length > 0 || q.fh.some((row) => row[0] > 0)) m |= 1 << 2;
  if ((q.pv?.c?.[3] || 0) >= 1) m |= 1 << 3;
  if (q.eq && Object.keys(q.eq).length > 0) m |= 1 << 4;
  return m;
}

export function createFirstSteps({ store, tracker, enabled }) {
  const p = () => store.state;
  let targets = {};

  function ensure() {
    const q = p();
    if (!Array.isArray(q.fs) || q.fs.length !== 2) {
      const m = inferMask(q);
      q.fs = [m, m === ALL_MASK ? 1 : 0];
      store.markDirty();
    }
    return q.fs;
  }
  ensure();

  const mask = () => ensure()[0];
  const isHidden = () => !!ensure()[1];
  const isDone = (i) => !!(mask() & (1 << i));
  const count = () => popcount(mask());

  function complete(i) {
    if (!enabled) return;
    const fs = ensure();
    if (fs[0] & (1 << i)) return; // once per step
    fs[0] |= 1 << i;
    tracker.addXp(XP_PER_STEP); // no bucket: a one-off award, same path as achievement XP
    if (fs[0] === ALL_MASK) fs[1] = 1; // done for good — no need for a "Скрыть" tap
    tracker.changed(); // persists + runs the 'first_steps' achievement check
    renderPill();
    if (isOpen()) renderSheet();
  }

  function hide() {
    const fs = ensure();
    if (fs[1]) return;
    fs[1] = 1;
    store.markDirty();
    renderPill();
  }

  // ---------- UI ----------
  const pill = $('fs-pill');
  const pillText = $('fs-pill-text');
  const root = $('fs-sheet');
  const body = $('fs-sheet-body');

  function renderPill() {
    if (!enabled || isHidden() || !pill) { if (pill) pill.hidden = true; return; }
    pill.hidden = false;
    const text = `${t('fs.title')} ${count()}/5`;
    if (pillText.textContent !== text) pillText.textContent = text;
  }

  function stepRow(i) {
    const def = STEPS[i];
    const done = isDone(i);
    return `<div class="fs-step${done ? ' done' : ''}">
      <img class="px-icon" src="${spriteDataUrl(...def.icon)}" alt="">
      <div class="fs-step-body">
        <div class="fs-step-name">${t(`fs.${def.key}.name`)}</div>
        <div class="fs-step-how read">${t(`fs.${def.key}.how`)}</div>
      </div>
      ${done ? `<span class="fs-step-check" aria-label="${t('fs.doneAria')}">✓</span>`
        : `<button class="btn fs-show" type="button" data-step="${i}">${t('fs.show')}</button>`}
    </div>`;
  }

  function renderSheet() {
    const n = count();
    body.innerHTML = `${STEPS.map((_, i) => stepRow(i)).join('')}
      <div class="fs-foot">${n >= 5 ? t('fs.allDone') : t('fs.xpEach')}</div>`;
  }

  const isOpen = () => root && !root.hidden;

  function open() {
    if (!root) return;
    renderSheet();
    root.classList.toggle('sheet', document.documentElement.dataset.layout !== 'wide');
    root.hidden = false;
    backButton(true, close);
  }
  function close() {
    if (!root || root.hidden) return;
    root.hidden = true;
    backButton(false, close);
  }

  if (root) {
    root.querySelector('.menu-backdrop').addEventListener('click', close);
    $('fs-sheet-close').addEventListener('click', close);
    $('fs-sheet-hide').addEventListener('click', () => { hide(); close(); });
    body.addEventListener('click', (e) => {
      const b = e.target.closest('[data-step]');
      if (!b) return;
      const key = STEPS[Number(b.dataset.step)].key;
      close();
      targets[key]?.();
    });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && isOpen()) close(); });
  }
  if (pill) pill.addEventListener('click', () => { hapticSelection(); open(); });

  store.onChange(renderPill);
  renderPill();

  return {
    complete,
    hide,
    isDone,
    get count() { return count(); },
    setTargets(t_) { targets = t_; },
    relabel() { renderPill(); if (isOpen()) renderSheet(); },
    open,
    close,
  };
}
