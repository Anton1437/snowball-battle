// Profile, achievements & forecasts UI (V105-CLIENT.md §4 + phase 5): HUD button, profile
// sheet (bottom sheet on phone, centred modal on wide), wide side-panel sections, the
// round-guess / time-forecast bar, the "backing today" prompt and a shared toast queue.
// Styling per design/DESIGN.md §8 and §10; readable text uses the --font-read token.
import { t, getLang, formatPrice } from './i18n.js?v=6561619d';
import { spriteDataUrl, compositeDataUrl } from './game/sprites-cache.js?v=6561619d';
import { ACHIEVEMENTS, RARITY_XP, levelOf } from './progress/achievements.js?v=6561619d';
import { HORIZONS } from './progress/forecast.js?v=6561619d';
import { backButton, hapticSelection, notify } from './tg.js?v=6561619d';
import { createKidCard, createWardrobe, itemPreviewUrl } from './wardrobe-ui.js?v=6561619d';

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

export function createProfileUi({ store, tracker, forecasts, cosmetics, enabled, storageLabelKey, userName, play, onBarResize }) {
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
    fcBarChips: $('fc-bar-chips'),
    fcRow2: $('fc-row2'),
    fcStatus: $('fc-status'),
    fcWideStatus: $('fc-wide-status'),
    fcActions: $('fc-actions'),
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
    const dot = cosmetics.hasUnseen();
    el.btn.classList.toggle('has-new', dot);
    el.btn.setAttribute('aria-label', `${t('prof.open')}: ${t('prof.level', { n: level })}${dot ? ` · ${t('wr.newDot')}` : ''}`);
    el.btn.title = t('prof.open');
  }

  // ---------- time until the next UTC day ----------
  function untilNextDay() {
    const now = Date.now();
    const next = (Math.floor(now / DAY_MS) + 1) * DAY_MS;
    const mins = Math.max(0, Math.round((next - now) / 60000));
    return { h: Math.floor(mins / 60), m: mins % 60, at: new Date(next).toLocaleTimeString(getLang(), { hour: '2-digit', minute: '2-digit' }) };
  }

  // ---------- kid card + wardrobe: built once, updated in place (sheet and wide panel) ----------
  const onPickSide = (side) => {
    if (tracker.pickSide(side)) {
      hapticSelection();
      cosmetics.refresh();
      render();
    }
  };
  const sheetCard = createKidCard({ store, tracker, cosmetics, userName, onPickSide });
  const sheetWardrobe = createWardrobe({ store, cosmetics, onEquip: () => hapticSelection() });
  const sheetRest = document.createElement('div');
  sheetRest.className = 'prof-rest';
  el.body.replaceChildren(sheetCard.el, sheetWardrobe.el, sheetRest);
  const panelCard = createKidCard({ store, tracker, cosmetics, userName, onPickSide });
  const panelWardrobe = createWardrobe({ store, cosmetics, onEquip: () => hapticSelection() });
  const panelRest = document.createElement('div');
  panelRest.className = 'prof-rest';
  el.panel.replaceChildren(panelCard.el, panelWardrobe.el, panelRest);

  function statsHtml() {
    const q = p();
    const pct = q.g[0] ? Math.round((q.g[1] / q.g[0]) * 100) : 0;
    const fcMade = q.fh.reduce((s, r) => s + r[0], 0);
    const fcWon = q.fh.reduce((s, r) => s + r[1], 0);
    const cell = (k, v) => `<div class="stat"><div class="stat-v num">${v}</div><div class="stat-k">${t(k)}</div></div>`;
    return `<div class="stats">${cell('prof.statWatch', `<span data-stat="watch">${Math.floor(q.w / 60)}</span>`)}${cell('prof.statRounds', q.rw)}
      ${cell('prof.statGuess', `${q.g[1]}/${q.g[0]} · ${pct}%`)}${cell('prof.statBest', q.g[3])}
      ${cell('prof.statFc', `${fcWon}/${fcMade}`)}${cell('prof.statGiants', q.gi)}</div>`;
  }

  const hhmm = (ms) => new Date(ms).toLocaleTimeString(getLang(), { hour: '2-digit', minute: '2-digit' });
  const candleRange = (h, t0, t1) => (HORIZONS[h].id === '1d'
    ? new Date(t0).toLocaleDateString(getLang(), { day: 'numeric', month: 'short' })
    : `${hhmm(t0)}–${hhmm(t1)}`);

  function fcRowsHtml(rows) {
    if (!rows.length) return `<div class="fc-empty">${t('fc.none')}</div>`;
    return rows.map((r) => {
      const when = r.kind === 'candle' ? candleRange(r.h, r.t0, r.t1) : '';
      const timer = r.state === 'resolving' ? t('fc.resolving')
        : r.state === 'queued' ? t('fc.startsIn', { t: fmtCountdown(r.remainingMs) }) : t('fc.endsIn', { t: fmtCountdown(r.remainingMs) });
      const mark = r.winning === true ? '✓' : r.winning === false ? '✗' : '·';
      return `<div class="fc-row ${r.winning === true ? 'win' : r.winning === false ? 'lose' : ''} ${r.state}">
        <span class="fc-h">${horizonLabel(r.h)}</span>
        <span class="fc-dir ${r.dir}"><i class="tri ${r.dir === 'u' ? 'up' : 'down'}" aria-hidden="true"></i>${t(r.dir === 'u' ? 'fc.up' : 'fc.down')}</span>
        <span class="fc-when num">${when}${r.open > 0 ? ` · $${formatPrice(r.open)}` : ''}</span>
        <span class="fc-time num">${timer}</span>
        <span class="fc-mark" aria-label="${r.winning === true ? t('fc.winning') : r.winning === false ? t('fc.losing') : ''}">${mark}</span>
      </div>`;
    }).join('');
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
    sheetRest.innerHTML = `${statsHtml()}
      <h3 class="menu-sub" id="prof-fc">${t('fc.title')}</h3>
      <div class="fc-list read">${fcRowsHtml(forecasts.list())}</div>${fcStatsHtml()}
      <h3 class="menu-sub">${t('prof.achTitle', { n: unlocked, total: achTotal })}</h3>
      <div class="ach-grid">${ACHIEVEMENTS.map(achCellHtml).join('')}</div>${detailHtml()}${resetHtml()}`;
    sheetCard.update(untilNextDay());
    sheetWardrobe.update();
  }

  function onBodyClick(e) {
    const cell = e.target.closest('[data-ach]');
    if (cell) {
      selectedAch = selectedAch === cell.dataset.ach ? null : cell.dataset.ach;
      render();
    }
  }
  el.body.addEventListener('click', onBodyClick);

  function open(section) {
    renderSheet();
    cosmetics.markViewed(); // clears the "new item" dot
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
    if (isOpen()) close();
  });

  // ---------- wide side-panel section ----------
  function renderPanel() {
    if (mode !== 'wide') return;
    const recent = ACHIEVEMENTS.filter((a) => p().a[a.id] != null)
      .sort((a, b) => p().a[b.id] - p().a[a.id]).slice(0, 5);
    panelRest.innerHTML = `<div class="recent">${recent.map((d) => `<img class="px-icon" src="${achIconUrl(d)}" alt="${esc(t(`ach.${d.id}.name`))}" title="${esc(t(`ach.${d.id}.name`))}">`).join('')}</div>
      <button class="btn all-ach" type="button" data-open-profile>${t('prof.allAch')} · ${Object.keys(p().a).length}/${achTotal}</button>`;
    panelCard.update(untilNextDay());
    panelWardrobe.update();
    cosmetics.markViewed(); // the wardrobe is on screen in the side panel
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

  // ---------- candle forecasts ----------
  // Chips are created once and then updated in place: this runs on the 250 ms UI refresh, and
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
    }
  }

  // «Свеча 5м 12:05–12:10» / «приём ещё 0:43» (or «ты за ЗЕЛЁНУЮ · старт через 0:43»)
  function statusLines() {
    if (!tracker.live) return [t('guess.demo'), ''];
    if (!forecasts.clockKnown) return [t('fc.waitClock'), ''];
    const st = forecasts.slot(horizon);
    const l1 = t('fc.candle', { h: horizonLabel(horizon), range: candleRange(horizon, st.t0, st.t1) });
    const cd = fmtCountdown(st.entryLeftMs);
    if (st.queued) {
      return [l1, `${t('fc.yourPick', { side: t(st.queued === 'u' ? 'fc.upAcc' : 'fc.downAcc') })} · ${t('fc.startsIn', { t: cd })}`];
    }
    return [l1, t('fc.entryLeft', { t: cd })];
  }

  function setStatus(box, [a, b]) {
    const l1 = box.firstElementChild;
    const l2 = box.lastElementChild;
    if (l1.textContent !== a) l1.textContent = a;
    if (l2.textContent !== b) l2.textContent = b;
  }

  function renderForecastControls() {
    if (!enabled) return;
    const can = forecasts.canOpen(horizon);
    const lines = statusLines();
    for (const b of [...el.fcActions.querySelectorAll('button'), ...el.fcWideActions.querySelectorAll('button')]) b.disabled = !can;
    const q = t('fc.q', { h: horizonLabel(horizon) });
    el.fcActions.title = q;
    el.fcActions.setAttribute('aria-label', q);
    if (mode === 'phone' && barMode === 'fc') {
      renderChips(el.fcBarChips);
      setStatus(el.fcStatus, lines);
    }
    if (mode === 'wide') {
      renderChips(el.fcChips);
      setStatus(el.fcWideStatus, lines);
      el.fcList.innerHTML = fcRowsHtml(forecasts.list());
    }
    if (isOpen()) {
      const list = el.body.querySelector('.fc-list');
      if (list) list.innerHTML = fcRowsHtml(forecasts.list());
    }
  }

  function pickHorizon(h) {
    if (h === horizon) return;
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
  const onChipClick = (e) => {
    const c = e.target.closest('[data-h]');
    if (c) pickHorizon(Number(c.dataset.h));
  };
  el.fcBarChips.addEventListener('click', onChipClick);
  el.fcChips.addEventListener('click', onChipClick);

  function setBarMode(m) {
    barMode = m;
    writeLs(BAR_MODE_KEY, m);
    renderGuess();
    onBarResize?.(); // the bar height changes → re-measure the HUD insets
  }
  el.guessMode.addEventListener('click', () => setBarMode(barMode === 'round' ? 'fc' : 'round'));

  function renderGuess() {
    renderRoundGuess();
    if (!enabled) return;
    const showFc = mode === 'phone' && barMode === 'fc';
    el.roundPart.hidden = showFc;
    el.fcBarChips.hidden = !showFc;
    el.fcRow2.hidden = !showFc;
    el.guess.classList.toggle('fc-mode', showFc);
    const mt = t(barMode === 'round' ? 'bar.round' : 'bar.time');
    if (el.guessMode.textContent !== mt) el.guessMode.textContent = mt;
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
    if (b.dataset.side !== 'later' && tracker.pickSide(b.dataset.side)) {
      hapticSelection();
      cosmetics.refresh(); // my kid moves to the backed team
    }
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

  function toastItem(item) {
    const thumb = item.slot === 'trail' || item.slot === 'frame' ? spriteDataUrl('crown', 'green', 2) : itemPreviewUrl(item, cosmetics.myTeam(), false);
    toastQueue.push({ kind: 'item', icon: thumb, kicker: t('wr.kicker'), name: t(`item.${item.id}`), xp: 0 }); // kicker «НОВЫЙ ПРЕДМЕТ» + item name
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
    // no watch-time / XP here: those tick every minute and are updated in place below, so
    // interactive cells (achievements) aren't rebuilt on a timer
    return JSON.stringify([q.rw, q.gi, q.wh, q.g, q.st, q.sd, q.a, q.fh, q.f.length, selectedAch, getLang(), mode]);
  };

  function render(force = true) {
    clearTimeout(renderTimer);
    renderTimer = 0;
    renderGuess();
    cosmetics.refresh();
    renderButton();
    // in-place updates (cheap, no DOM rebuild)
    if (isOpen()) sheetCard.update(untilNextDay());
    if (mode === 'wide') panelCard.update(untilNextDay());
    const mins = String(Math.floor(p().w / 60));
    for (const n of document.querySelectorAll('[data-stat="watch"]')) if (n.textContent !== mins) n.textContent = mins;
    const sig = viewSig();
    if (!force && sig === lastSig) return;
    lastSig = sig;
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
    setLayout, render, toastUnlock, toastForecast, toastItem, showSidePrompt, renderGuess, open, close,
    get isOpen() { return isOpen(); },
  };
}
