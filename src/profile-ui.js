// Profile & achievements UI (V105-CLIENT.md §4): HUD button, profile sheet (bottom sheet on
// phone, centred modal on wide), wide side-panel section, round-guess bar, side-of-the-day
// prompt and unlock toasts. Styling per design/DESIGN.md §8 and §10.
import { t, getLang } from './i18n.js?v=84e3b46d';
import { spriteDataUrl, compositeDataUrl } from './game/sprites-cache.js?v=84e3b46d';
import { ACHIEVEMENTS, RARITY_XP, levelOf } from './progress/achievements.js?v=84e3b46d';
import { backButton, hapticSelection, notify } from './tg.js?v=84e3b46d';

const TOAST_HOLD_MS = 2500;
const TOAST_POP = [{ transform: 'scale(0.2)' }, { transform: 'scale(1)' }];
const TOAST_POP_OPTS = { duration: 240, easing: 'steps(3, jump-end)' };
const DAY_MS = 86_400_000;

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function achIconUrl(def, locked = false) {
  if (def.icon === 'hot5') {
    return compositeDataUrl('hot5', [{ name: 'ball_big', x: 0, y: 4 }, { name: 'ach_flame', x: 4, y: 0 }], 14, 14, 2, locked);
  }
  const [name, team, scale] = def.icon;
  return spriteDataUrl(name, team, scale, 0, locked);
}

export function createProfileUi({ store, tracker, enabled, storageLabelKey, userName, play, onReady }) {
  const el = {
    btn: $('btn-profile'),
    btnIcon: $('btn-profile-icon'),
    btnLevel: $('btn-profile-level'),
    sheetRoot: $('profile-sheet'),
    body: $('profile-body'),
    panel: $('profile-panel'),
    guess: $('guess-panel'),
    guessLabel: $('guess-label'),
    guessActions: $('guess-actions'),
    guessNote: $('guess-note'),
    side: $('side'),
    scorePanel: $('score-panel'),
    hudBottom: $('hud-bottom'),
    feedPanel: $('feed-panel'),
    sidePrompt: $('side-prompt'),
    toast: $('ach-toast'),
    toastIcon: $('ach-toast-icon'),
    toastName: $('ach-toast-name'),
    toastXp: $('ach-toast-xp'),
    banner: $('banner'),
  };
  let mode = 'phone';
  let selectedAch = null;
  let renderTimer = 0;
  const toastQueue = [];
  let toastBusy = false;

  const p = () => store.state;
  const name = () => userName || t('prof.guest');
  const isOpen = () => !el.sheetRoot.hidden;

  // ---------- HUD button ----------
  function renderButton() {
    if (!enabled) return;
    el.btn.hidden = false;
    const side = tracker.sideState().picked;
    el.btnIcon.src = side === 'g' ? spriteDataUrl('icon_head_back', 'green', 2)
      : side === 'r' ? spriteDataUrl('icon_head_front', 'red', 2) : spriteDataUrl('ball_big', 'green', 2);
    const { level } = levelOf(p().xp);
    el.btnLevel.textContent = level;
    el.btn.setAttribute('aria-label', `${t('prof.open')}: ${t('prof.level', { n: level })}`);
    el.btn.title = t('prof.open');
  }

  // ---------- shared fragments ----------
  function headerHtml() {
    const q = p();
    const lv = levelOf(q.xp);
    const side = tracker.sideState();
    const sideTxt = side.picked === 'g' ? t('guess.green') : side.picked === 'r' ? t('guess.red') : t('prof.sideNone');
    return `
      <div class="prof-head">
        <div class="prof-name">${esc(name())}</div>
        <div class="prof-level">${t('prof.level', { n: lv.level })}</div>
      </div>
      <div class="xpbar" role="img" aria-label="${t('prof.xp', { a: lv.into, b: lv.need })}"><i style="width:${Math.round((lv.into / lv.need) * 100)}%"></i></div>
      <div class="prof-row"><span class="xp-txt">${t('prof.xp', { a: lv.into, b: lv.need })}</span>
        <span class="streak"><img class="px-icon" src="${spriteDataUrl('ach_icicle', 'green', 2)}" alt="">${t('prof.streak', { n: q.st[0] })}</span></div>
      <div class="prof-row side-row"><span>${t('prof.side')}: <b class="side-${side.picked || 'none'}">${sideTxt}</b></span></div>`;
  }

  function sideButtonsHtml() {
    const side = tracker.sideState();
    if (!side.canChange) return '';
    const btn = (s) => (side.picked === s ? '' : `<button class="gbtn ${s}" type="button" data-pick="${s}"><i class="tri ${s === 'g' ? 'up' : 'down'}" aria-hidden="true"></i>${t(s === 'g' ? 'guess.green' : 'guess.red')}</button>`);
    const label = side.picked ? t('prof.sideSwitch') : t('prof.sidePick');
    return `<div class="side-pick"><span class="side-pick-label">${label}</span>${btn('g')}${btn('r')}</div>`;
  }

  function statsHtml() {
    const q = p();
    const pct = q.g[0] ? Math.round((q.g[1] / q.g[0]) * 100) : 0;
    const cell = (k, v) => `<div class="stat"><div class="stat-v">${v}</div><div class="stat-k">${t(k)}</div></div>`;
    return `<div class="stats">${cell('prof.statWatch', Math.floor(q.w / 60))}${cell('prof.statRounds', q.rw)}
      ${cell('prof.statGuess', `${q.g[1]}/${q.g[0]} · ${pct}%`)}${cell('prof.statBest', q.g[3])}
      ${cell('prof.statGiants', q.gi)}${cell('prof.statWhales', q.wh)}</div>`;
  }

  function achCellHtml(def) {
    const day = p().a[def.id];
    const locked = day == null;
    const prog = locked && def.progress ? def.progress(p()) : null;
    const bar = prog ? `<span class="ach-prog"><i style="width:${Math.round((prog[0] / prog[1]) * 100)}%"></i></span>` : '';
    return `<button class="ach ${locked ? 'locked' : `r-${def.rarity}`}${selectedAch === def.id ? ' sel' : ''}" type="button" data-ach="${def.id}"
        aria-label="${esc(t(`ach.${def.id}.name`))}${locked ? `, ${t('prof.locked')}` : ''}">
      <span class="ach-badge r-${def.rarity}">${t(`rar.${def.rarity}`)}</span>
      <img class="px-icon" src="${achIconUrl(def, locked)}" alt="">
      <span class="ach-name">${esc(t(`ach.${def.id}.name`))}</span>${bar}</button>`;
  }

  const dateOf = (day) => new Date(day * DAY_MS).toLocaleDateString(getLang(), { day: 'numeric', month: 'short', year: 'numeric' });

  function detailHtml() {
    const def = ACHIEVEMENTS.find((a) => a.id === selectedAch);
    if (!def) return '';
    const day = p().a[def.id];
    const prog = day == null && def.progress ? def.progress(p()) : null;
    return `<div class="ach-detail"><b>${esc(t(`ach.${def.id}.name`))}</b> · ${t(`rarName.${def.rarity}`)} · +${RARITY_XP[def.rarity]} XP<br>
      ${esc(t(`ach.${def.id}.desc`))}<br><span class="dim">${day != null ? t('prof.unlockedOn', { d: dateOf(day) }) : `${t('prof.locked')}${prog ? ` · ${prog[0]}/${prog[1]}` : ''}`}</span></div>`;
  }

  function resetHtml() {
    const now = Date.now();
    const next = (Math.floor(now / DAY_MS) + 1) * DAY_MS;
    const mins = Math.max(0, Math.round((next - now) / 60000));
    const at = new Date(next).toLocaleTimeString(getLang(), { hour: '2-digit', minute: '2-digit' });
    return `<div class="prof-foot">${t('prof.resetIn', { h: Math.floor(mins / 60), m: mins % 60, t: at })}<br>
      ${t(storageLabelKey)} ${t('prof.demoNote')}<br>${t('guess.leaveNote')}</div>`;
  }

  // ---------- sheet ----------
  function renderSheet() {
    const unlocked = Object.keys(p().a).length;
    el.body.innerHTML = `${headerHtml()}${sideButtonsHtml()}${statsHtml()}
      <h3 class="menu-sub">${t('prof.achTitle', { n: unlocked })}</h3>
      <div class="ach-grid">${ACHIEVEMENTS.map(achCellHtml).join('')}</div>${detailHtml()}${resetHtml()}`;
  }

  function onBodyClick(e) {
    const cell = e.target.closest('[data-ach]');
    if (cell) {
      selectedAch = selectedAch === cell.dataset.ach ? null : cell.dataset.ach;
      render();
      return;
    }
    const pick = e.target.closest('[data-pick]');
    if (pick && tracker.pickSide(pick.dataset.pick)) {
      hapticSelection();
      render();
    }
  }
  el.body.addEventListener('click', onBodyClick);

  function open() {
    renderSheet();
    el.sheetRoot.classList.toggle('sheet', mode === 'phone');
    el.sheetRoot.hidden = false;
    backButton(true, close);
    $('profile-close').focus();
  }

  function close() {
    if (!isOpen()) return;
    el.sheetRoot.hidden = true;
    backButton(false, close);
    el.btn.focus();
  }

  el.btn.addEventListener('click', () => (isOpen() ? close() : open()));
  el.sheetRoot.querySelector('.menu-backdrop').addEventListener('click', close);
  $('profile-close').addEventListener('click', close);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && isOpen()) close(); });

  // ---------- wide side-panel section ----------
  function renderPanel() {
    if (mode !== 'wide') return;
    const recent = ACHIEVEMENTS.filter((a) => p().a[a.id] != null)
      .sort((a, b) => p().a[b.id] - p().a[a.id]).slice(0, 5);
    el.panel.innerHTML = `${headerHtml()}${sideButtonsHtml()}
      <div class="recent">${recent.map((d) => `<img class="px-icon" src="${achIconUrl(d)}" alt="${esc(t(`ach.${d.id}.name`))}" title="${esc(t(`ach.${d.id}.name`))}">`).join('')}</div>
      <button class="btn all-ach" type="button" data-open-profile>${t('prof.allAch')} · ${Object.keys(p().a).length}/15</button>`;
  }
  el.panel.addEventListener('click', (e) => {
    if (e.target.closest('[data-open-profile]')) open();
    else onBodyClick(e);
  });

  // ---------- guess bar ----------
  function renderGuess() {
    const gs = tracker.guessState();
    el.guess.hidden = gs.mode === 'off';
    if (gs.mode === 'off') return;
    el.guess.dataset.mode = gs.mode;
    let label;
    switch (gs.mode) {
      case 'open': label = mode === 'phone' ? t('guess.askShort') : t('guess.ask', { n: gs.roundNo }); break;
      case 'done': label = t('guess.yours', { side: t(gs.side === 'g' ? 'guess.green' : 'guess.red') }); break;
      case 'locked': label = t('guess.locked'); break;
      case 'demo': label = t('guess.demo'); break;
      default: label = t('guess.wait');
    }
    el.guessLabel.textContent = label;
    el.guess.dataset.side = gs.side || '';
    el.guess.title = gs.mode === 'open' ? `${t('guess.ask', { n: gs.roundNo })} ${t('guess.leaveNote')}` : label;
    const open = gs.mode === 'open';
    el.guessActions.hidden = !open;
    for (const b of el.guessActions.querySelectorAll('button')) b.disabled = !open;
  }
  el.guessActions.addEventListener('click', (e) => {
    const b = e.target.closest('[data-side]');
    if (b && tracker.guess(b.dataset.side)) {
      hapticSelection();
      renderGuess();
    }
  });

  // ---------- side-of-the-day prompt ----------
  function showSidePrompt() {
    if (!enabled || tracker.sideState().picked) return;
    el.sidePrompt.hidden = false;
  }
  el.sidePrompt.addEventListener('click', (e) => {
    const b = e.target.closest('[data-side]');
    if (!b) return;
    if (b.dataset.side !== 'later' && tracker.pickSide(b.dataset.side)) hapticSelection();
    el.sidePrompt.hidden = true;
    render();
  });

  // ---------- unlock toast ----------
  function pumpToasts() {
    if (toastBusy || !toastQueue.length) return;
    if (!el.banner.hidden) { // wait for the victory banner to clear
      setTimeout(pumpToasts, 400);
      return;
    }
    const { def, xp } = toastQueue.shift();
    toastBusy = true;
    el.toastIcon.src = achIconUrl(def);
    el.toastName.textContent = t(`ach.${def.id}.name`);
    el.toastXp.textContent = `+${xp} XP`;
    el.toast.hidden = false;
    if (!document.hidden && el.toast.animate) el.toast.animate(TOAST_POP, TOAST_POP_OPTS);
    notify('success');
    play?.('victory', { intensity: 0.4 });
    setTimeout(() => {
      el.toast.hidden = true;
      toastBusy = false;
      pumpToasts();
    }, TOAST_HOLD_MS);
  }

  function toastUnlock(def, xp) {
    toastQueue.push({ def, xp });
    pumpToasts();
  }

  // ---------- layout ----------
  // phone: guess bar sits above the feed inside #hud-bottom (part of measureInsets()).
  // wide: profile + guess sections go into the side panel under the score.
  function setLayout(nextMode) {
    mode = nextMode;
    if (!enabled) return;
    if (mode === 'wide') {
      el.panel.hidden = false;
      el.scorePanel.after(el.panel, el.guess);
    } else {
      el.panel.hidden = true;
      el.hudBottom.prepend(el.guess);
      el.side.append(el.panel); // parked (hidden) until wide again
    }
    el.sheetRoot.classList.toggle('sheet', mode === 'phone');
    render();
  }

  // Re-render only when something visible changed (watch seconds tick every second).
  let lastSig = '';
  const viewSig = () => {
    const q = p();
    return JSON.stringify([Math.floor(q.w / 60), q.rw, q.gi, q.wh, q.g, q.st, q.xp, q.sd, q.a, selectedAch, getLang(), mode]);
  };

  function render(force = true) {
    clearTimeout(renderTimer);
    renderTimer = 0;
    renderGuess();
    const sig = viewSig();
    if (!force && sig === lastSig) return;
    lastSig = sig;
    renderButton();
    renderPanel();
    if (isOpen()) renderSheet();
  }

  // Coalesce frequent store changes (watch time ticks every second).
  function scheduleRender() {
    if (!renderTimer) renderTimer = setTimeout(() => render(false), 250);
  }
  store.onChange(scheduleRender);
  setInterval(renderGuess, 200); // lock state follows the raw price (the click is re-checked anyway)

  if (!enabled) {
    el.guess.hidden = true;
    el.btn.hidden = true;
  }
  onReady?.();

  return {
    setLayout, render, toastUnlock, showSidePrompt, renderGuess, open, close,
    get isOpen() { return isOpen(); },
  };
}
