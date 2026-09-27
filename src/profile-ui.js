// Profile, achievements & forecasts UI (V105-CLIENT.md §4 + phase 5): HUD button, profile
// sheet (bottom sheet on phone, centred modal on wide), wide side-panel sections, the
// round-guess / time-forecast bar, the "backing today" prompt and a shared toast queue.
// Styling per design/DESIGN.md §8 and §10; readable text uses the --font-read token.
import { t, getLang, formatPrice } from './i18n.js?v=4055052d';
import { spriteDataUrl, compositeDataUrl } from './game/sprites-cache.js?v=4055052d';
import { ACHIEVEMENTS, RARITY_XP, levelOf } from './progress/achievements.js?v=4055052d';
import { HORIZONS } from './progress/forecast.js?v=4055052d';
import { backButton, hapticSelection, notify } from './tg.js?v=4055052d';

const TOAST_HOLD_MS = 2500;
const TOAST_POP = [{ transform: 'scale(0.2)' }, { transform: 'scale(1)' }];
const TOAST_POP_OPTS = { duration: 240, easing: 'steps(3, jump-end)' };
const DAY_MS = 86_400_000;
const BAR_MODE_KEY = 'sb.barMode';
const HORIZON_KEY = 'sb.fch';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const readLs = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const writeLs = (k, v) => { try { localStorage.setItem(k, v); } catch { /* ignore */ } };

export function achIconUrl(def, locked = false) {
  if (def.icon === 'hot5') {
    return compositeDataUrl('hot5', [{ name: 'ball_big', x: 0, y: 4 }, { name: 'ach_flame', x: 4, y: 0 }], 14, 14, 2, locked);
  }
  const [name, team, scale] = def.icon;
  return spriteDataUrl(name, team, scale, 0, locked);
}

export const horizonLabel = (h) => t(`fc.h.${HORIZONS[h].id}`);

// 12:34 under an hour, otherwise "3ч 05м" / "3h 05m".
function fmtCountdown(ms) {
  const s = Math.ceil(ms / 1000);
  if (s < 3600) return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return t('fc.hm', { h, m: String(m).padStart(2, '0') });
}

export function createProfileUi({ store, tracker, forecasts, enabled, storageLabelKey, userName, play }) {
  const el = {
    btn: $('btn-profile'),
    btnIcon: $('btn-profile-icon'),
    btnLevel: $('btn-profile-level'),
    sheetRoot: $('profile-sheet'),
    body: $('profile-body'),
    panel: $('profile-panel'),
    guess: $('guess-panel'),
    guessMode: $('guess-mode'),
    roundPart: $('guess-round'),
    guessLabel: $('guess-label'),
    guessActions: $('guess-actions'),
    fcPart: $('guess-fc'),
    fcPick: $('fc-pick'),
    fcPicker: $('fc-picker'),
    fcActions: $('fc-actions'),
    fcCount: $('fc-count'),
    fcPanel: $('forecast-panel'),
    fcChips: $('fc-chips'),
    fcWideActions: $('fc-wide-actions'),
    fcList: $('fc-list'),
    side: $('side'),
    scorePanel: $('score-panel'),
    hudBottom: $('hud-bottom'),
    sidePrompt: $('side-prompt'),
    toast: $('ach-toast'),
    toastIcon: $('ach-toast-icon'),
    toastKicker: $('ach-toast-kicker'),
    toastName: $('ach-toast-name'),
    toastXp: $('ach-toast-xp'),
    banner: $('banner'),
  };
  let mode = 'phone';
  let barMode = readLs(BAR_MODE_KEY) === 'fc' ? 'fc' : 'round';
  let horizon = Math.min(HORIZONS.length - 1, Math.max(0, Number(readLs(HORIZON_KEY)) || 1));
  let selectedAch = null;
  let renderTimer = 0;
  const toastQueue = [];
  let toastBusy = false;

  const p = () => store.state;
  const name = () => userName || t('prof.guest');
  const isOpen = () => !el.sheetRoot.hidden;
  const achTotal = ACHIEVEMENTS.length;

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

  // ---------- time until the next UTC day ----------
  function untilNextDay() {
    const now = Date.now();
    const next = (Math.floor(now / DAY_MS) + 1) * DAY_MS;
    const mins = Math.max(0, Math.round((next - now) / 60000));
    return { h: Math.floor(mins / 60), m: mins % 60, at: new Date(next).toLocaleTimeString(getLang(), { hour: '2-digit', minute: '2-digit' }) };
  }

  // ---------- shared fragments ----------
  function headerHtml() {
    const q = p();
    const lv = levelOf(q.xp);
    const side = tracker.sideState();
    const sideTxt = side.picked === 'g' ? t('prof.backGreen') : side.picked === 'r' ? t('prof.backRed') : t('prof.sideNone');
    const until = untilNextDay();
    return `
      <div class="prof-head">
        <div class="prof-name">${esc(name())}</div>
        <div class="prof-level">${t('prof.level', { n: lv.level })}</div>
      </div>
      <div class="xpbar" role="img" aria-label="${t('prof.xp', { a: lv.into, b: lv.need })}"><i style="width:${Math.round((lv.into / lv.need) * 100)}%"></i></div>
      <div class="prof-row"><span class="xp-txt num">${t('prof.xp', { a: lv.into, b: lv.need })}</span>
        <span class="streak"><img class="px-icon" src="${spriteDataUrl('ach_icicle', 'green', 2)}" alt="">${t('prof.streak', { n: q.st[0] })}</span></div>
      <div class="prof-row side-row"><span>${t('prof.side')}: <b class="side-${side.picked || 'none'}">${sideTxt}</b>${side.picked
        ? ` · ${t('prof.sideNext', { h: until.h, m: until.m })}` : ''}</span></div>
      <div class="prof-note">${t('prof.sideNote')}</div>`;
  }

  // Only when nothing is picked today: the profile shows the side as info, not a control.
  function sidePickHtml() {
    if (tracker.sideState().picked) return '';
    return `<div class="side-pick"><span class="side-pick-label">${t('prof.sidePick')}</span>
      <button class="gbtn g" type="button" data-pick="g"><i class="tri up" aria-hidden="true"></i>${t('side.green')}</button>
      <button class="gbtn r" type="button" data-pick="r"><i class="tri down" aria-hidden="true"></i>${t('side.red')}</button></div>`;
  }

  function statsHtml() {
    const q = p();
    const pct = q.g[0] ? Math.round((q.g[1] / q.g[0]) * 100) : 0;
    const fcMade = q.fh.reduce((s, r) => s + r[0], 0);
    const fcWon = q.fh.reduce((s, r) => s + r[1], 0);
    const cell = (k, v) => `<div class="stat"><div class="stat-v num">${v}</div><div class="stat-k">${t(k)}</div></div>`;
    return `<div class="stats">${cell('prof.statWatch', Math.floor(q.w / 60))}${cell('prof.statRounds', q.rw)}
      ${cell('prof.statGuess', `${q.g[1]}/${q.g[0]} · ${pct}%`)}${cell('prof.statBest', q.g[3])}
      ${cell('prof.statFc', `${fcWon}/${fcMade}`)}${cell('prof.statGiants', q.gi)}</div>`;
  }

  function fcRowsHtml(rows) {
    if (!rows.length) return `<div class="fc-empty">${t('fc.none')}</div>`;
    return rows.map((r) => `<div class="fc-row ${r.winning === true ? 'win' : r.winning === false ? 'lose' : ''}">
        <span class="fc-h">${horizonLabel(r.h)}</span>
        <span class="fc-dir ${r.dir}"><i class="tri ${r.dir === 'u' ? 'up' : 'down'}" aria-hidden="true"></i>${t(r.dir === 'u' ? 'fc.up' : 'fc.down')}</span>
        <span class="fc-entry num">$${formatPrice(r.entry)}</span>
        <span class="fc-time num">${r.pending ? t('fc.resolving') : fmtCountdown(r.remainingMs)}</span>
        <span class="fc-mark" aria-label="${r.winning === true ? t('fc.winning') : r.winning === false ? t('fc.losing') : ''}">${r.winning === true ? '✓' : r.winning === false ? '✗' : '·'}</span>
      </div>`).join('');
  }

  function fcStatsHtml() {
    const q = p();
    return `<table class="fc-stats"><thead><tr><th></th>${HORIZONS.map((_, h) => `<th>${horizonLabel(h)}</th>`).join('')}</tr></thead>
      <tbody><tr><th>${t('fc.statWon')}</th>${q.fh.map((r) => `<td class="num">${r[1]}/${r[0]}</td>`).join('')}</tr>
      <tr><th>${t('fc.statBest')}</th>${q.fh.map((r) => `<td class="num">${r[3]}</td>`).join('')}</tr></tbody></table>`;
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
    const u = untilNextDay();
    return `<div class="prof-foot">${t('prof.resetIn', { h: u.h, m: u.m, t: u.at })}<br>
      ${t(storageLabelKey)} ${t('prof.demoNote')}<br>${t('guess.leaveNote')} ${t('fc.offlineNote')}</div>`;
  }

  // ---------- sheet ----------
  function renderSheet() {
    const unlocked = Object.keys(p().a).length;
    el.body.innerHTML = `${headerHtml()}${sidePickHtml()}${statsHtml()}
      <h3 class="menu-sub" id="prof-fc">${t('fc.title')}</h3>
      <div class="fc-list read">${fcRowsHtml(forecasts.list())}</div>${fcStatsHtml()}
      <h3 class="menu-sub">${t('prof.achTitle', { n: unlocked, total: achTotal })}</h3>
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

  function open(section) {
    renderSheet();
    el.sheetRoot.classList.toggle('sheet', mode === 'phone');
    el.sheetRoot.hidden = false;
    backButton(true, close);
    if (section) $(section)?.scrollIntoView({ block: 'start' });
    $('profile-close').focus({ preventScroll: true });
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
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!el.fcPicker.hidden) el.fcPicker.hidden = true;
    else if (isOpen()) close();
  });

  // ---------- wide side-panel section ----------
  function renderPanel() {
    if (mode !== 'wide') return;
    const recent = ACHIEVEMENTS.filter((a) => p().a[a.id] != null)
      .sort((a, b) => p().a[b.id] - p().a[a.id]).slice(0, 5);
    el.panel.innerHTML = `${headerHtml()}${sidePickHtml()}
      <div class="recent">${recent.map((d) => `<img class="px-icon" src="${achIconUrl(d)}" alt="${esc(t(`ach.${d.id}.name`))}" title="${esc(t(`ach.${d.id}.name`))}">`).join('')}</div>
      <button class="btn all-ach" type="button" data-open-profile>${t('prof.allAch')} · ${Object.keys(p().a).length}/${achTotal}</button>`;
  }
  el.panel.addEventListener('click', (e) => {
    if (e.target.closest('[data-open-profile]')) open();
    else onBodyClick(e);
  });

  // ---------- round guess ----------
  function renderRoundGuess() {
    const gs = tracker.guessState();
    el.guess.hidden = gs.mode === 'off';
    if (gs.mode === 'off') return;
    el.guess.dataset.gmode = gs.mode;
    let label;
    switch (gs.mode) {
      case 'open': label = mode === 'phone' ? t('guess.askShort') : t('guess.ask', { n: gs.roundNo }); break;
      case 'done': label = t('guess.yours', { side: t(gs.side === 'g' ? 'guess.green' : 'guess.red') }); break;
      case 'locked': label = t('guess.locked'); break;
      case 'demo': label = t('guess.demo'); break;
      default: label = t('guess.wait');
    }
    el.guessLabel.textContent = label;
    el.roundPart.dataset.side = gs.side || '';
    el.roundPart.title = gs.mode === 'open' ? `${t('guess.ask', { n: gs.roundNo })} ${t('guess.leaveNote')}` : label;
    el.guessActions.setAttribute('aria-label', t('guess.ask', { n: gs.roundNo }));
    const openNow = gs.mode === 'open';
    el.guessActions.hidden = !openNow;
    for (const b of el.guessActions.querySelectorAll('button')) b.disabled = !openNow;
  }
  el.guessActions.addEventListener('click', (e) => {
    const b = e.target.closest('[data-side]');
    if (b && tracker.guess(b.dataset.side)) {
      hapticSelection();
      renderGuess();
    }
  });

  // ---------- time forecasts ----------
  // Chips are created once and then updated in place: this runs on the 200 ms UI refresh, and
  // replacing the buttons between pointerdown and pointerup swallows the tap (always on iOS).
  function renderChips(container) {
    if (container.children.length !== HORIZONS.length) {
      container.innerHTML = HORIZONS.map((_, h) =>
        `<button class="chip" type="button" role="radio" data-h="${h}"></button>`).join('');
    }
    for (const b of container.children) {
      const h = Number(b.dataset.h);
      const busy = forecasts.isActive(h);
      const text = `${horizonLabel(h)}${busy ? '⏱' : ''}`;
      if (b.textContent !== text) b.textContent = text;
      b.classList.toggle('on', h === horizon);
      b.classList.toggle('busy', busy);
      b.setAttribute('aria-checked', String(h === horizon));
      b.title = busy ? t('fc.busy') : '';
    }
  }

  function renderForecastControls() {
    if (!enabled) return;
    const rows = forecasts.list();
    const can = forecasts.canOpen(horizon);
    const busy = forecasts.isActive(horizon);
    const live = tracker.live;
    // phone bar
    const pickHtml = `${horizonLabel(horizon)}<i class="caret" aria-hidden="true"></i>`;
    if (el.fcPick.dataset.h !== String(horizon) || el.fcPick.dataset.lang !== t('fc.pickH')) {
      el.fcPick.innerHTML = pickHtml;
      el.fcPick.dataset.h = String(horizon);
      el.fcPick.dataset.lang = t('fc.pickH');
    }
    el.fcPick.setAttribute('aria-label', `${t('fc.pickH')}: ${horizonLabel(horizon)}`);
    el.fcCount.textContent = rows.length ? t('fc.active', { n: rows.length }) : '';
    el.fcCount.hidden = !rows.length;
    for (const b of [...el.fcActions.querySelectorAll('button'), ...el.fcWideActions.querySelectorAll('button')]) b.disabled = !can;
    el.fcPart.title = !live ? t('guess.demo') : busy ? t('fc.busy') : t('fc.ask', { h: horizonLabel(horizon) });
    el.fcPart.dataset.state = !live ? 'demo' : busy ? 'busy' : 'open';
    if (!el.fcPicker.hidden) renderChips(el.fcPicker);
    // wide section
    if (mode === 'wide') {
      renderChips(el.fcChips);
      $('fc-wide-hint').textContent = !live ? t('guess.demo') : busy ? t('fc.busy') : t('fc.ask', { h: horizonLabel(horizon) });
      el.fcList.innerHTML = fcRowsHtml(rows);
    }
    if (isOpen()) {
      const list = el.body.querySelector('.fc-list');
      if (list) list.innerHTML = fcRowsHtml(rows);
    }
  }

  function pickHorizon(h) {
    horizon = h;
    writeLs(HORIZON_KEY, String(h));
    hapticSelection();
    renderForecastControls();
  }

  function openForecast(dir) {
    if (forecasts.open(horizon, dir)) {
      hapticSelection();
      renderForecastControls();
      render();
    }
  }

  const onDirClick = (e) => {
    const b = e.target.closest('[data-dir]');
    if (b) openForecast(b.dataset.dir);
  };
  el.fcActions.addEventListener('click', onDirClick);
  el.fcWideActions.addEventListener('click', onDirClick);
  el.fcPick.addEventListener('click', () => {
    el.fcPicker.hidden = !el.fcPicker.hidden;
    el.fcPick.setAttribute('aria-expanded', String(!el.fcPicker.hidden));
    if (!el.fcPicker.hidden) renderChips(el.fcPicker);
  });
  el.fcPicker.addEventListener('click', (e) => {
    const c = e.target.closest('[data-h]');
    if (!c) return;
    pickHorizon(Number(c.dataset.h));
    el.fcPicker.hidden = true;
  });
  el.fcChips.addEventListener('click', (e) => {
    const c = e.target.closest('[data-h]');
    if (c) pickHorizon(Number(c.dataset.h));
  });
  el.fcCount.addEventListener('click', () => open('prof-fc'));

  function setBarMode(m) {
    barMode = m;
    writeLs(BAR_MODE_KEY, m);
    renderGuess();
  }
  el.guessMode.addEventListener('click', () => setBarMode(barMode === 'round' ? 'fc' : 'round'));

  function renderGuess() {
    renderRoundGuess();
    if (!enabled) return;
    const showFc = mode === 'phone' && barMode === 'fc';
    el.roundPart.hidden = showFc;
    el.fcPart.hidden = !showFc;
    if (!showFc) el.fcPicker.hidden = true;
    el.guessMode.textContent = t(barMode === 'round' ? 'bar.round' : 'bar.time');
    el.guessMode.setAttribute('aria-label', t('bar.switch'));
    renderForecastControls();
  }

  // ---------- "backing today" prompt ----------
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

  // ---------- toasts (achievements + forecast results share one queue) ----------
  function pumpToasts() {
    if (toastBusy || !toastQueue.length) return;
    if (!el.banner.hidden) { // wait for the victory banner to clear
      setTimeout(pumpToasts, 400);
      return;
    }
    const item = toastQueue.shift();
    toastBusy = true;
    el.toastIcon.src = item.icon;
    el.toastKicker.textContent = item.kicker;
    el.toastName.textContent = item.name;
    el.toastXp.textContent = item.xp ? `+${item.xp} XP` : '';
    el.toast.dataset.kind = item.kind;
    el.toast.hidden = false;
    if (!document.hidden && el.toast.animate) el.toast.animate(TOAST_POP, TOAST_POP_OPTS);
    if (item.kind === 'ach' || item.kind === 'win') notify('success');
    if (item.kind === 'ach') play?.('victory', { intensity: 0.4 });
    setTimeout(() => {
      el.toast.hidden = true;
      toastBusy = false;
      pumpToasts();
    }, TOAST_HOLD_MS);
  }

  function toastUnlock(def, xp) {
    toastQueue.push({ kind: 'ach', icon: achIconUrl(def), kicker: t('toast.ach'), name: t(`ach.${def.id}.name`), xp });
    pumpToasts();
  }

  function toastForecast(res) {
    const kind = res.result;
    const h = horizonLabel(res.h);
    const key = kind === 'win' ? 'fc.toastWin' : kind === 'loss' ? 'fc.toastLoss' : 'fc.toastVoid';
    const icon = kind === 'win' ? spriteDataUrl('crown', 'green', 2) : spriteDataUrl(res.dir === 'u' ? 'icon_head_back' : 'icon_head_front', res.dir === 'u' ? 'green' : 'red', 2);
    toastQueue.push({ kind, icon, kicker: t('fc.toastKicker'), name: t(key, { h }), xp: res.xp });
    pumpToasts();
  }

  // ---------- layout ----------
  // phone: the bar sits above the feed inside #hud-bottom (part of measureInsets()).
  // wide: profile, round guess and forecast sections go into the side panel under the score.
  function setLayout(nextMode) {
    mode = nextMode;
    if (!enabled) return;
    if (mode === 'wide') {
      el.panel.hidden = false;
      el.fcPanel.hidden = false;
      el.scorePanel.after(el.panel, el.guess, el.fcPanel);
    } else {
      el.panel.hidden = true;
      el.fcPanel.hidden = true;
      el.hudBottom.prepend(el.guess);
      el.side.append(el.panel, el.fcPanel); // parked (hidden) until wide again
    }
    el.guessMode.hidden = mode !== 'phone';
    el.sheetRoot.classList.toggle('sheet', mode === 'phone');
    render();
  }

  // Re-render only when something visible changed (watch seconds tick every second).
  let lastSig = '';
  const viewSig = () => {
    const q = p();
    return JSON.stringify([Math.floor(q.w / 60), q.rw, q.gi, q.wh, q.g, q.st, q.xp, q.sd, q.a, q.fh, q.f.length, selectedAch, getLang(), mode]);
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

  function scheduleRender() {
    if (!renderTimer) renderTimer = setTimeout(() => render(false), 250);
  }
  store.onChange(scheduleRender);
  setInterval(renderGuess, 250); // guess lock + forecast countdowns follow the live price

  if (!enabled) {
    el.guess.hidden = true;
    el.btn.hidden = true;
  }

  return {
    setLayout, render, toastUnlock, toastForecast, showSidePrompt, renderGuess, open, close,
    get isOpen() { return isOpen(); },
  };
}
