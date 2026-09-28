// PvP duels UI (gamification/PVP-SPEC.md §11): entry / fight / result / stats screens over the
// existing field canvas. DOM is built once in index.html and only mutated in place (HANDOFF.md
// timers rule). Input is touch/pointer, no 300 ms delay (pointerdown/up, not click, drives throws).
import { t } from '../i18n.js?v=17c4945d';
import {
  SPRITES, PALETTE, frames, drawSprite, spriteDataUrl,
} from '../game/sprites-cache.js?v=17c4945d';
import { drawKidLook, drawYouMarker } from '../game/kid-art.js?v=17c4945d';
import { fitCanvas } from '../game/renderer.js?v=17c4945d';
import { buildLook } from '../cosmetics.js?v=17c4945d';
import { levelOf } from '../progress/achievements.js?v=17c4945d';
import { utcDayOf } from '../progress/store.js?v=17c4945d';
import {
  haptic, hapticSelection, notify, isAppActive, onAppActiveChange,
} from '../tg.js?v=17c4945d';
import { play } from '../audio.js?v=17c4945d';
import * as SIM from './sim.js?v=17c4945d';

const $ = (id) => document.getElementById(id);
const ENERGY_MAX = 10;
const ENERGY_REGEN_MS = 6 * 60 * 1000;
const RESPEC_DAYS = 7;
const ABANDON_MS = 90_000;
const STAT_NAMES = ['rate', 'power', 'accuracy', 'agility', 'stamina'];
const STAT_ICON = ['ball_small', 'ball_big', 'ach_target', 'puff', 'ach_flame'];
const PVP_ACH_IDS = [
  'pvp_first', 'pvp_win', 'pvp_giant', 'pvp_sniper', 'pvp_fortress',
  'pvp_clutch', 'pvp_headwind', 'pvp_flawless', 'pvp_streak5', 'pvp_legend',
];
const ACH_ICON = {
  pvp_first: ['ball_small', 'green', 2], pvp_win: ['crown', 'green', 2], pvp_giant: ['giant_back_idle', 'green', 1],
  pvp_sniper: ['ach_target', 'green', 2], pvp_fortress: ['fort_back', 'green', 2], pvp_clutch: ['ach_flame', 'green', 2],
  pvp_headwind: ['flag_team', 'red', 2], pvp_flawless: ['ach_iceball', 'green', 2], pvp_streak5: ['ach_calendar', 'green', 2],
  pvp_legend: ['crown', 'green', 2],
};

export function createPvp({ store, tracker }) {
  const root = $('pvp');
  if (!root) return { open() {}, close() {}, isOpen: () => false, relabel() {}, setEnabled() {} };
  const el = {
    close: $('pvp-close'),
    screens: { entry: $('pvp-entry'), fight: $('pvp-fight'), result: $('pvp-result'), stats: $('pvp-stats') },
    leagueIcon: $('pvp-league-icon'), leagueName: $('pvp-league-name'), leagueSub: $('pvp-league-sub'),
    leagueFill: $('pvp-league-fill'), leagueStreak: $('pvp-league-streak'),
    energyLabel: $('pvp-energy-label'), energyRegen: $('pvp-energy-regen'), pips: $('pvp-pips'), xpToday: $('pvp-xp-today'),
    oppPreview: $('pvp-opp-preview').getContext('2d'), oppName: $('pvp-opp-name'), oppMeta: $('pvp-opp-meta'), oppDesc: $('pvp-opp-desc'),
    startBot: $('pvp-start-bot'), startPractice: $('pvp-start-practice'), openStats: $('pvp-open-stats'),
    fhudIcon: $('pvp-fhud-icon'), fhudName: $('pvp-fhud-name'),
    hpOpp: $('pvp-hp-opp'), hpOppT: $('pvp-hp-opp-t'), timer: $('pvp-timer'), wind: $('pvp-wind'),
    arenaBox: $('pvp-arena-box'), arena: $('pvp-arena'), hint: $('pvp-hint'),
    giantBtn: $('pvp-giant-btn'), giantIcon: $('pvp-giant-icon'),
    over: $('pvp-over'), overBand: $('pvp-over-band'), overGo: $('pvp-over-go'),
    meIcon: $('pvp-me-icon'), hpMe: $('pvp-hp-me'), hpMeT: $('pvp-hp-me-t'), stam: $('pvp-stam'),
    btnLeft: $('pvp-btn-left'), btnRight: $('pvp-btn-right'), btnDuck: $('pvp-btn-duck'),
    btnThrow: $('pvp-btn-throw'), throwIcon: $('pvp-throw-icon'), throwRing: $('pvp-throw-ring-fg'),
    handToggle: $('pvp-hand-toggle'),
    rband: $('pvp-rband'), rbandTitle: $('pvp-rband-title'), rbandSub: $('pvp-rband-sub'),
    resArt: $('pvp-res-art').getContext('2d'), rKv: $('pvp-r-kv'), rAch: $('pvp-r-ach'),
    again: $('pvp-again'), rStats: $('pvp-r-stats'),
    free: $('pvp-free'), statsNote: $('pvp-stats-note'), statList: $('pvp-stat-list'),
    respec: $('pvp-respec'), respecNote: $('pvp-respec-note'),
    hudBtn: $('btn-pvp'), hudIcon: $('btn-pvp-icon'), hudEnergy: $('btn-pvp-energy'),
  };
  const g = el.arena.getContext('2d');
  g.imageSmoothingEnabled = false;
  el.oppPreview.imageSmoothingEnabled = false;
  el.resArt.imageSmoothingEnabled = false;
  el.hudIcon.src = spriteDataUrl('ach_target', 'green', 2); // distinct from the profile button's head icon
  el.giantIcon.src = spriteDataUrl('giant_back_idle', 'green', 1);
  if (el.throwIcon) el.throwIcon.src = spriteDataUrl('ball_big', 'green', 2);

  let enabled = false;
  let getPressure = () => 0;
  let getSource = () => null;
  let open = false;
  let screen = 'entry';
  let match = null;
  let opp = null; // { tier, persona, points, name(key) }
  let practice = false;
  let pendingActions = []; // this-frame decoded codes for 'me', drained into the next tick
  let lastResult = null;   // { win, meHp, opHp, hits, throws, fort, giants, wind, headwind, rating, xp, achIds }
  let rafId = 0;
  let lastFrame = 0;
  let acc = 0;
  let W = 192; let H = 300;
  let hintShown = false;
  let hiddenAt = 0;
  let sessionStreak = { wins: 0, losses: 0 }; // dynamic difficulty (§6.1); session-only, not persisted
  let movePtr = null; // pointer/touch state for the arena swipe-to-move gesture
  let throwHold = null; // { id, buzzed } — active hold on the THROW button (v1.081)
  let kbThrowHeld = false; // desktop debug: spacebar hold mirrors the THROW button

  // ---------- handedness (v1.081): mirrors the move/throw cluster, persisted locally ----------
  const HAND_KEY = 'sb_pvp_hand';
  const loadHand = () => { try { return localStorage.getItem(HAND_KEY) === 'left' ? 'left' : 'right'; } catch { return 'right'; } };
  const saveHand = (v) => { try { localStorage.setItem(HAND_KEY, v); } catch { /* ignore */ } };
  let hand = loadHand();
  function applyHand() {
    root.classList.toggle('pvp-lefty', hand === 'left');
    if (el.handToggle) el.handToggle.textContent = hand === 'left' ? t('pvp.handLeft') : t('pvp.handRight');
  }
  applyHand();

  const pv = () => store.state.pv;
  const today = () => utcDayOf(Date.now());

  // ---------- energy ----------
  function energyNow() {
    const [amt, at] = pv().e;
    const gained = Math.floor((Date.now() - at) / ENERGY_REGEN_MS);
    return Math.min(ENERGY_MAX, amt + Math.max(0, gained));
  }
  function energySync() { // fold accrued regen into the stored value (call before spending/showing)
    const cur = energyNow();
    if (cur !== pv().e[0]) pv().e = [cur, Date.now()];
    else if (cur >= ENERGY_MAX) pv().e[1] = Date.now(); // don't let the regen clock drift past the cap
    return cur;
  }
  function spendEnergy() {
    energySync();
    pv().e = [Math.max(0, pv().e[0] - 1), pv().e[1]];
    store.markDirty();
  }
  function msToNextEnergy() {
    if (energyNow() >= ENERGY_MAX) return 0;
    const [, at] = pv().e;
    return ENERGY_REGEN_MS - ((Date.now() - at) % ENERGY_REGEN_MS);
  }

  // ---------- HUD badge (outside the overlay; kept live whether it's open or not) ----------
  function renderHudBadge() {
    if (!enabled) { el.hudBtn.hidden = true; return; }
    el.hudBtn.hidden = false;
    el.hudEnergy.textContent = String(energyNow());
  }
  setInterval(renderHudBadge, 15000);

  // ---------- entry screen ----------
  function pickOpponent() {
    const rating = pv().r;
    const { tier, persona } = SIM.pickBot(rating, Math.random, difficultyStep());
    const points = SIM.botPointsBudget(pv().s, Math.random);
    opp = { tier, persona, points };
  }
  function difficultyStep() {
    if (sessionStreak.losses >= 2) return -1;
    if (sessionStreak.wins >= 3) return 1;
    return 0;
  }
  function leagueProgress() {
    const league = SIM.leagueFor(pv().r);
    const idx = SIM.LEAGUES.indexOf(league);
    const next = SIM.LEAGUES[idx + 1];
    return { league, next };
  }
  function renderEntry() {
    energySync();
    const e = energyNow();
    el.energyLabel.textContent = t('pvp.energy', { n: e, max: ENERGY_MAX });
    el.energyRegen.innerHTML = e >= ENERGY_MAX ? '' : t('pvp.regenIn', { m: fmtMs(msToNextEnergy()) });
    el.pips.innerHTML = '';
    for (let i = 0; i < ENERGY_MAX; i++) {
      const d = document.createElement('i');
      if (i < e) d.classList.add('on');
      el.pips.appendChild(d);
    }
    const { league, next } = leagueProgress();
    el.leagueIcon.src = spriteDataUrl('crown', 'green', 4);
    el.leagueName.textContent = t(`pvp.league.${league.id}`);
    el.leagueSub.textContent = next
      ? t('pvp.leagueSub', { r: pv().r, need: Math.max(0, next.min - pv().r), next: t(`pvp.league.${next.id}`) })
      : t('pvp.leagueTop', { r: pv().r });
    const span = next ? next.min - league.min : 200;
    const into = next ? Math.max(0, Math.min(span, pv().r - league.min)) : span;
    el.leagueFill.style.width = `${Math.round((into / span) * 100)}%`;
    el.leagueStreak.textContent = t('pvp.localLeague', { n: pv().w[3] });
    el.xpToday.textContent = t('pvp.xpToday', { n: store.state.xd[5] || 0, max: 60 });
    if (!opp) pickOpponent();
    renderOpponentCard();
    el.startBot.disabled = e < 1;
    el.openStats.textContent = t('pvp.statsOpen', { n: freePoints() });
    applyHand();
  }
  el.handToggle?.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    hand = hand === 'left' ? 'right' : 'left';
    saveHand(hand);
    applyHand();
    hapticSelection();
  });
  function renderOpponentCard() {
    const persona = SIM.personaOf(opp.persona);
    el.oppPreview.clearRect(0, 0, 14, 20);
    drawKidLook(el.oppPreview, 'kid_front_idle', 'red', 0, 7, 19, null);
    el.oppName.textContent = t(`pvp.bot.${persona.id}.name`);
    el.oppMeta.textContent = t('pvp.oppMeta', { tier: persona.tier, league: t(`pvp.league.${SIM.leagueFor(pv().r).id}`), pts: opp.points.reduce((a, b) => a + b, 0) });
    el.oppDesc.textContent = t(`pvp.bot.${persona.id}.desc`);
  }
  const fmtMs = (ms) => { const s = Math.ceil(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

  // ---------- stats screen ----------
  function freePoints() {
    const level = levelOf(store.state.xp).level;
    const total = Math.max(0, level - 1);
    return Math.max(0, total - pv().s.reduce((a, b) => a + b, 0));
  }
  function renderStats() {
    const free = freePoints();
    el.free.textContent = t('pvp.free', { n: free });
    el.statsNote.textContent = t('pvp.statsNote', { level: levelOf(store.state.xp).level });
    el.statList.innerHTML = '';
    const pts = pv().s;
    pts.forEach((p, i) => {
      const d0 = SIM.deriveStats(pts);
      const nx = [...pts]; nx[i] = Math.min(10, p + 1);
      const d1 = SIM.deriveStats(nx);
      const row = document.createElement('div');
      row.className = 'pvp-stat';
      const pip = Array.from({ length: 10 }, (_, k) => `<i class="${k < p ? 'on' : ''} ${k >= 5 ? 'soft' : ''}"></i>`).join('');
      row.innerHTML = `<img src="${spriteDataUrl(STAT_ICON[i], 'green', 2)}" alt="">
        <div><div class="nm">${t(`pvp.stat.${STAT_NAMES[i]}`)} <span>/ ${t(`pvp.stat.${STAT_NAMES[i]}.en`)}</span></div>
        <div class="pvp-spips">${pip}</div>
        <div class="v">${fmtStat(i, d0)}${free > 0 && p < 10 ? ` → <b>${fmtStat(i, d1)}</b>` : ''}</div></div>
        <button class="btn pvp-btn" type="button" data-m="${i}" ${p === 0 ? 'disabled' : ''}>−</button>
        <button class="btn pvp-btn primary" type="button" data-p="${i}" ${free === 0 || p >= 10 ? 'disabled' : ''}>+</button>`;
      el.statList.appendChild(row);
    });
    el.statList.querySelectorAll('[data-p]').forEach((b) => { b.onclick = () => { pv().s[+b.dataset.p]++; store.markDirty(); renderStats(); renderEntry(); }; });
    el.statList.querySelectorAll('[data-m]').forEach((b) => { b.onclick = () => toast(t('pvp.decreaseHint')); });
    const daysLeft = RESPEC_DAYS - (today() - pv().rs);
    const canRespec = daysLeft <= 0;
    el.respec.disabled = !canRespec;
    el.respec.textContent = canRespec ? t('pvp.respecFree') : t('pvp.respecCooldown', { d: Math.max(1, daysLeft) });
    el.respecNote.textContent = t('pvp.respecNote');
  }
  const fmtStat = (i, d) => [
    t('pvp.stat.cdVal', { s: d.cd.toFixed(2) }), t('pvp.stat.dmgVal', { v: d.dmg.toFixed(1) }),
    t('pvp.stat.sigmaVal', { v: d.sigma.toFixed(1) }), t('pvp.stat.stepVal', { s: d.step.toFixed(2) }),
    t('pvp.stat.stamVal', { v: Math.round(d.stamMax), r: d.regen.toFixed(1) }),
  ][i];
  el.respec.addEventListener('click', () => {
    if (el.respec.disabled) return;
    pv().s = [0, 0, 0, 0, 0];
    pv().rs = today();
    store.markDirty();
    renderStats();
    toast(t('pvp.respecDone'));
  });

  // ---------- toast (reuses the arena hint slot when idle, else a transient DOM node) ----------
  function toast(text) {
    const n = document.createElement('div');
    n.className = 'pvp-hint';
    n.style.position = 'fixed';
    n.style.left = '50%'; n.style.bottom = '90px'; n.style.transform = 'translateX(-50%)'; n.style.zIndex = 80;
    n.textContent = text;
    root.appendChild(n);
    setTimeout(() => n.remove(), 2000);
  }

  // ---------- windows series sampling from live market pressure ----------
  function windForcedCalm() {
    const src = getSource();
    return practice || src === 'DEMO' || src == null || (pv().tu !== 1 && pv().c[3] < 3);
  }
  function sampleWind() {
    const p = Math.max(-1, Math.min(1, getPressure() || 0));
    return Math.round(p * 0.06 * 1000) / 1000;
  }

  // ---------- fight lifecycle ----------
  function showScreen(name) {
    screen = name;
    for (const [k, s] of Object.entries(el.screens)) s.classList.toggle('on', k === name);
    if (name === 'entry') renderEntry();
    else if (name === 'stats') renderStats();
    else if (name === 'result') renderResult();
  }

  function startDuel(isPractice) {
    practice = isPractice;
    if (!practice) {
      energySync();
      if (energyNow() < 1) return;
      spendEnergy();
    }
    if (!opp) pickOpponent();
    const seed = ((Math.random() * 0xffffffff) ^ (performance.now() * 1000)) >>> 0;
    const calm = windForcedCalm();
    match = SIM.createMatch({
      seed, myPoints: pv().s, botTier: opp.tier, botPersona: opp.persona, botPoints: opp.points,
      practice, windSeries: [[0, calm ? 0 : sampleWind()]],
    });
    match._calm = calm;
    match._nextWindTick = calm ? Infinity : SIM.TICK_HZ * 5;
    resultShown = false;
    layoutArena();
    match.me.y = Math.round(0.74 * H);
    match.op.y = Math.round(0.30 * H);
    hintShown = false;
    el.hint.hidden = pv().tu === 1 || pv().c[3] >= 3;
    el.hint.textContent = t(`pvp.tut.${Math.min(2, pv().c[3])}`);
    el.over.classList.remove('show');
    el.giantBtn.classList.remove('show');
    const persona = SIM.personaOf(opp.persona);
    el.fhudIcon.src = spriteDataUrl('icon_head_front', 'red', 1);
    el.fhudName.textContent = t(`pvp.bot.${persona.id}.name`);
    el.meIcon.src = spriteDataUrl('icon_head_back', 'green', 1);
    showScreen('fight');
    if (!practice) toast(t('pvp.energySpent', { n: energyNow() }));
    lastFrame = performance.now();
    acc = 0;
    cancelAnimationFrame(rafId);
    rafId = requestAnimationFrame(loop);
  }
  let resultShown = false;

  function layoutArena() {
    const w = el.arenaBox.clientWidth; const h = el.arenaBox.clientHeight;
    if (!w || !h) return;
    const fit = fitCanvas(w, h, window.devicePixelRatio || 1);
    H = fit.H; W = SIM.ARENA_W;
    el.arena.width = W; el.arena.height = H;
    el.arena.style.height = `${H * fit.css}px`;
    g.imageSmoothingEnabled = false;
    if (match) { match.me.y = Math.round(0.74 * H); match.op.y = Math.round(0.30 * H); }
  }
  window.addEventListener('resize', () => { if (screen === 'fight') layoutArena(); });

  function loop(now) {
    if (screen !== 'fight' || !match) return;
    const dt = Math.min(0.1, Math.max(0, (now - lastFrame) / 1000));
    lastFrame = now;
    if (!document.hidden && isAppActive()) {
      acc += dt;
      let steps = 0;
      while (acc >= SIM.TICK_DT && steps < 8) {
        acc -= SIM.TICK_DT; steps++;
        if (!match._calm && match.tick >= match._nextWindTick) {
          match.windSeries.push([match.tick, sampleWind()]);
          match._nextWindTick += SIM.TICK_HZ * 5;
        }
        SIM.tick(match, pendingActions);
        pendingActions = [];
        if (match.phase === 'end') break;
      }
    }
    updateFightHud();
    updateThrowRing();
    draw();
    if (match.phase === 'end' && !resultShown) { resultShown = true; onDuelEnd(); }
    rafId = requestAnimationFrame(loop);
  }

  function updateFightHud() {
    el.hpOpp.style.width = `${match.op.hp}%`; el.hpOppT.textContent = Math.ceil(match.op.hp);
    el.hpMe.style.width = `${match.me.hp}%`; el.hpMeT.textContent = Math.ceil(match.me.hp);
    el.stam.style.width = `${(100 * match.me.stam) / match.me.d.stamMax}%`;
    el.timer.textContent = match.phase === 'count' ? Math.ceil(match.countTicks / SIM.TICK_HZ)
      : match.phase === 'sudden' ? Math.ceil(match.sdTicks / SIM.TICK_HZ)
      : Math.max(0, Math.ceil(match.leftTicks / SIM.TICK_HZ));
    const pct = Math.round(match.wind * 100);
    el.wind.innerHTML = match._calm ? t('pvp.calm') : `${t('pvp.wind')} <b class="${pct < 0 ? 'neg' : ''}">${pct >= 0 ? `▲ +${pct}` : `▼ −${Math.abs(pct)}`}%</b> · ${t(pct >= 0 ? 'pvp.windBuy' : 'pvp.windSell')}`;
    if (match.me.combo >= 3 && match.me.giants < 2 && !match.giant) el.giantBtn.classList.add('show');
    else el.giantBtn.classList.remove('show');
  }

  // ---------- input (v1.081: pointer events, touch-action:none on every control — no 300 ms
  // delay, no text selection, no double-tap zoom; every handler is scoped to its own element/
  // pointerId so a THROW hold and a ◀ tap from a second finger don't interfere, HANDOFF.md's
  // "never rebuild on a timer" rule kept — the DOM is built once in index.html). ----------
  function queue(code) {
    pendingActions.push(code);
    if (match) SIM.logMe(match, code);
  }
  function hideHint() { if (!hintShown) { hintShown = true; el.hint.hidden = true; } }

  // Swipe-to-move on the field (§3): tap does nothing now (auto-aim replaced tap-a-lane), only a
  // ≥24px horizontal drag steps a lane, same threshold as before.
  el.arenaBox.addEventListener('pointerdown', (e) => {
    if (!match || match.phase === 'end' || e.target.closest('button')) return;
    movePtr = { id: e.pointerId, x: e.clientX, moved: false };
  });
  el.arenaBox.addEventListener('pointermove', (e) => {
    if (!movePtr || e.pointerId !== movePtr.id || movePtr.moved) return;
    const dx = e.clientX - movePtr.x;
    if (Math.abs(dx) >= 24) {
      movePtr.moved = true;
      queue(dx > 0 ? SIM.CODE.MOVE_R : SIM.CODE.MOVE_L);
      hideHint();
    }
  });
  const endMovePtr = (e) => { if (movePtr && e.pointerId === movePtr.id) movePtr = null; };
  el.arenaBox.addEventListener('pointerup', endMovePtr);
  el.arenaBox.addEventListener('pointercancel', endMovePtr);

  el.btnLeft.addEventListener('pointerdown', (e) => { e.preventDefault(); queue(SIM.CODE.MOVE_L); hideHint(); });
  el.btnRight.addEventListener('pointerdown', (e) => { e.preventDefault(); queue(SIM.CODE.MOVE_R); hideHint(); });
  const duckOn = (e) => { e.preventDefault(); queue(SIM.CODE.DUCK_ON); el.btnDuck.classList.add('on'); hideHint(); };
  const duckOff = () => { queue(SIM.CODE.DUCK_OFF); el.btnDuck.classList.remove('on'); };
  el.btnDuck.addEventListener('pointerdown', duckOn);
  ['pointerup', 'pointerleave', 'pointercancel'].forEach((ev) => el.btnDuck.addEventListener(ev, duckOff));

  // THROW button (§2): tap = quick throw, hold = charges the ring 0→max over CHARGE_MAX_TICKS
  // (~0.8s); release throws. Charge amount is derived sim-side from the tick gap between
  // THROW_START/THROW_RELEASE (§9 — never trusts a client-reported duration). Pointer capture
  // keeps the hold alive even if the finger drifts off the round button's edge.
  el.btnThrow.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    if (!match || match.phase === 'end' || throwHold) return;
    try { el.btnThrow.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    throwHold = { id: e.pointerId, buzzed: false };
    queue(SIM.CODE.THROW_START);
    hideHint();
  });
  const throwRelease = (e) => {
    if (!throwHold || e.pointerId !== throwHold.id) return;
    throwHold = null;
    queue(SIM.CODE.THROW_RELEASE);
    play('throw', { intensity: 0.3 });
  };
  el.btnThrow.addEventListener('pointerup', throwRelease);
  el.btnThrow.addEventListener('pointercancel', throwRelease);

  el.giantBtn.addEventListener('pointerdown', (e) => { e.preventDefault(); queue(SIM.CODE.GIANT); play('giant', { intensity: 0.7 }); });
  el.overGo.addEventListener('click', () => showScreen('result'));

  function updateThrowRing() {
    if (!el.throwRing) return;
    let frac = 0;
    if (match && match.me.chargeStartTick >= 0) {
      frac = Math.min(1, (match.tick - match.me.chargeStartTick) / SIM.CHARGE_MAX_TICKS);
    }
    const c = 2 * Math.PI * 44;
    el.throwRing.style.strokeDasharray = `${c}`;
    el.throwRing.style.strokeDashoffset = `${c * (1 - frac)}`;
    if (frac >= 1 && throwHold && !throwHold.buzzed) { throwHold.buzzed = true; haptic('rigid'); }
  }

  // ---------- draw (ported from gamification/pvp-mockup.html, real sprites/kid-art) ----------
  function kidAnim(k) {
    const view = k.team === 'green' ? 'back' : 'front';
    if (match.phase === 'end') {
      const won = (k === match.me) === (match.result?.winner === 'me');
      return [`kid_${view}_${won ? 'cheer' : 'duck'}`, Math.floor(match.tick / 10)];
    }
    if (k.animState === 'hit' && k.animTicksLeft > 0) return [`kid_${view}_hit`, k.animTicksLeft > 9 ? 0 : 1];
    if (k.duck) return [`kid_${view}_duck`, Math.floor(match.tick / 30)];
    if (k === match.me && k.chargeStartTick >= 0) return [`kid_${view}_windup`, 0];
    if (k.animState === 'throw' && k.animTicksLeft > 0) return [`kid_${view}_throw`, k.animTicksLeft > 6 ? 0 : 1];
    return [`kid_${view}_idle`, Math.floor(match.tick / 30 + (k === match.op ? 1 : 0))];
  }
  function ring(cx, cy, r, frac, col, bg) {
    const n = 24;
    for (let i = 0; i < n; i++) {
      const a = -Math.PI / 2 + (i / n) * Math.PI * 2;
      g.fillStyle = i / n < frac ? col : bg;
      g.fillRect(Math.round(cx + Math.cos(a) * r), Math.round(cy + Math.sin(a) * r), 1, 1);
    }
  }
  function draw() {
    for (let ty = 0; ty < H; ty += 16) {
      for (let tx = 0; tx < W; tx += 16) {
        const h = ((tx * 73856093) ^ (ty * 19349663)) >>> 0;
        g.drawImage(frames(h % 10 < 6 ? 'snow_tile_a' : h % 10 < 8 ? 'snow_tile_b' : 'snow_tile_c')[0], tx, ty);
      }
    }
    g.fillStyle = PALETTE.b;
    for (let y = 0; y < H; y += 3) { g.fillRect(64, y, 1, 1); g.fillRect(128, y, 1, 1); }
    const acts = [];
    const fortY = { red: match.op.y + 8, green: match.me.y - 10 };
    for (const team of ['red', 'green']) {
      for (let l = 0; l < 3; l++) {
        const hp = match.forts[team][l]; const y = fortY[team];
        acts.push({
          y,
          d: () => {
            if (hp > 0) {
              drawSprite(g, team === 'red' ? 'fort_front' : 'fort_back', SIM.LANES_X[l], y, team);
            } else drawSprite(g, 'snow_pile', SIM.LANES_X[l], y, team);
          },
        });
      }
    }
    for (const k of [match.me, match.op]) {
      const [name, fr] = kidAnim(k);
      const x = SIM.kidX(k);
      const isMe = k === match.me;
      acts.push({
        y: k.y,
        d: () => {
          drawSprite(g, 'shadow_kid', x, k.y);
          const look = isMe ? myLookCache : null;
          drawKidLook(g, name, k.team, fr % SPRITES[name].frames.length, x, k.y, look, match.tick / SIM.TICK_HZ);
          if (isMe) {
            drawYouMarker(g, name, fr % SPRITES[name].frames.length, x, k.y, look, Math.floor(match.tick / 30) % 2);
            if (match.phase === 'fight' || match.phase === 'sudden') {
              if (k.chargeStartTick >= 0) {
                const frac = Math.min(1, (match.tick - k.chargeStartTick) / SIM.CHARGE_MAX_TICKS);
                ring(x, k.y - 8, 11, frac, PALETTE.c, PALETTE.K);
              } else if (k.cdTicks > 0) {
                ring(x, k.y - 8, 11, 1 - k.cdTicks / Math.round(k.d.cd * SIM.TICK_HZ), PALETTE.Y, PALETTE.K);
              }
            }
          }
        },
      });
    }
    if (match.giant) {
      const G = match.giant; const me = G.k === match.me;
      const nm = me ? 'giant_back_throw' : 'giant_front_throw';
      const fr = G.ageTicks < 24 ? 0 : G.ageTicks < 42 ? 1 : 2;
      const gy = me ? match.me.y + 14 : match.op.y - 10;
      const gx = SIM.LANES_X[G.lane];
      acts.push({ y: gy, d: () => { drawSprite(g, 'shadow_giant', gx, gy); drawSprite(g, nm, gx, gy, me ? 'green' : 'red', fr); } });
    }
    acts.sort((a, b) => a.y - b.y).forEach((a) => a.d());
    for (const b of match.balls) {
      const tt = Math.min(1, b.ageTicks / b.durTicks);
      const gx = b.x0 + (b.x1 - b.x0) * tt; const gy = b.y0 + (b.y1 - b.y0) * tt;
      const peak = b.big ? Math.max(14, Math.min(40, 0.35 * Math.hypot(b.x1 - b.x0, b.y1 - b.y0))) : Math.max(6, Math.min(24, 0.22 * Math.hypot(b.x1 - b.x0, b.y1 - b.y0)));
      const z = b.z0 * (1 - tt) + 4 * peak * tt * (1 - tt);
      g.globalAlpha = 0.35 + 0.65 * tt;
      drawSprite(g, b.big ? 'shadow_big' : 'shadow_small', b.x1, b.y1);
      g.globalAlpha = 1;
      drawSprite(g, b.big ? 'ball_big' : 'ball_small', gx, gy - z);
    }
  }

  // ---------- duel end: XP, rating, achievements, storage (PVP-SPEC.md §6.3, §10.1) ----------
  function onDuelEnd() {
    const r = match.result;
    const win = r.winner === 'me';
    const draw_ = r.winner === 'draw';
    play(win ? 'victory' : 'splat', { intensity: 0.5 });
    haptic(win ? 'heavy' : draw_ ? 'medium' : 'light');
    notify(win ? 'success' : draw_ ? 'warning' : 'error');
    el.overBand.className = `pvp-band ${win ? 'g' : draw_ ? 'n' : 'r'}`;
    el.overBand.textContent = t(win ? 'pvp.win' : draw_ ? 'pvp.draw' : 'pvp.loss');
    el.over.classList.add('show');
    el.giantBtn.classList.remove('show');

    if (practice) { lastResult = { r, win, draw: draw_, xp: 0, ratingDelta: 0, achIds: [] }; return; }

    const q = pv();
    const beforeAch = new Set(Object.keys(store.state.a));
    q.c[3]++;
    if (r.giants > 0) q.c[0] += 1;
    if (win && opp.tier === 'T5') q.c[1]++;
    if (win && r.meHp >= 100) q.c[2]++;
    if (win) { q.w[0]++; q.w[3]++; q.w[4] = Math.max(q.w[4], q.w[3]); sessionStreak = { wins: sessionStreak.wins + 1, losses: 0 }; } else if (draw_) { q.w[2]++; sessionStreak = { wins: 0, losses: 0 }; } else { q.w[1]++; q.w[3] = 0; sessionStreak = { wins: 0, losses: sessionStreak.losses + 1 }; }
    const isFirstWinToday = win && q.lw !== today();
    if (win) q.lw = today();
    let xpAmount = win ? 10 : draw_ ? 6 : 4;
    if (isFirstWinToday) xpAmount += 20;
    const xpAwarded = tracker.addXp(xpAmount, 'pvp');
    let delta = win ? SIM.RATING_DELTA.win : draw_ ? SIM.RATING_DELTA.draw : SIM.RATING_DELTA.loss;
    const newRating = q.r + delta;
    q.r = SIM.leagueFor(q.r).id !== 'bronze' ? Math.max(SIM.RATING_FLOOR_AFTER_SILVER, newRating) : Math.max(0, newRating);
    if (q.c[3] >= 3) q.tu = 1;

    const ctx = { pvp: {
      win, sniper: r.bestHitStreak >= 5, fortress: win && r.myFortHits >= 8, clutch: win && r.meHp <= 10,
      headwind: win && r.maxHeadwind <= -0.04,
    } };
    tracker.changed(ctx);
    const achIds = PVP_ACH_IDS.filter((id) => !beforeAch.has(id) && store.state.a[id] != null);
    lastResult = { r, win, draw: draw_, xp: xpAwarded, ratingDelta: delta, achIds, opp };
  }

  function renderResult() {
    const res = lastResult;
    if (!res) return;
    const { r } = res;
    el.rband.className = `pvp-rband ${res.win ? 'g' : res.draw ? 'n' : 'r'}`;
    el.rbandTitle.textContent = t(res.win ? 'pvp.win' : res.draw ? 'pvp.draw' : 'pvp.loss');
    const persona = SIM.personaOf(opp.persona);
    el.rbandSub.textContent = practice ? t('pvp.practiceLabel') : `${t(`pvp.bot.${persona.id}.name`)} · ${t('pvp.botBadge')} ${opp.tier}`;
    const x = el.resArt;
    for (let tx = 0; tx < 192; tx += 16) for (let ty = 0; ty < 70; ty += 16) x.drawImage(frames('snow_tile_a')[0], tx, ty);
    drawSprite(x, 'fort_front', 150, 36, 'red');
    drawKidLook(x, res.win ? 'kid_front_duck' : 'kid_front_cheer', 'red', 0, 150, 30, null);
    drawSprite(x, 'fort_back', 50, 52, 'green');
    drawKidLook(x, res.win ? 'kid_back_cheer' : 'kid_back_duck', 'green', 0, 50, 62, myLookCache);
    drawSprite(x, 'crown', res.win ? 50 : 150, res.win ? 38 : 8, 'green');
    const acc_ = r.throws ? Math.round((100 * r.hits) / r.throws) : 0;
    const rows = [
      ['pvp.kv.hp', `${r.meHp} : ${r.opHp}`],
      ['pvp.kv.hits', `${r.hits}/${r.throws} · ${acc_}%`],
      ['pvp.kv.fort', `${r.myFortHits}`],
      ['pvp.kv.giant', `${r.giants}`],
      ['pvp.kv.wind', match._calm ? t('pvp.calm') : `${r.wind >= 0 ? '+' : '−'}${Math.abs(Math.round(r.wind * 100))}%`],
      ['pvp.kv.xp', practice ? t('pvp.practiceLabel') : `+${res.xp}`],
      ['pvp.kv.xpToday', practice ? '—' : `${store.state.xd[5] || 0} / 60`],
      ['pvp.kv.rating', practice ? '—' : `${res.ratingDelta >= 0 ? '+' : ''}${res.ratingDelta} → ${pv().r} · ${t(`pvp.league.${SIM.leagueFor(pv().r).id}`)}`],
      ['pvp.kv.streak', `${pv().w[3]}`],
    ];
    el.rKv.innerHTML = rows.map(([k, v]) => `<span>${t(k)}</span><b>${v}</b>`).join('');
    el.rAch.innerHTML = res.achIds.length
      ? res.achIds.map((id) => `<span class="pvp-chip"><img class="px-icon" src="${spriteDataUrl(...ACH_ICON[id])}" alt="">${t(`ach.${id}.name`)}</span>`).join('')
      : `<span class="pvp-dim">${t('pvp.noNewAch')}</span>`;
  }
  el.again.addEventListener('click', () => { pickOpponent(); startDuel(false); });
  el.rStats.addEventListener('click', () => showScreen('stats'));

  // ---------- abandonment (backgrounded ≥ 90 s mid-duel, §11.12) ----------
  function onVisible(active) {
    if (active) {
      if (hiddenAt && match && !practice && (match.phase === 'fight' || match.phase === 'sudden' || match.phase === 'count')) {
        if (Date.now() - hiddenAt >= ABANDON_MS) {
          match.phase = 'end';
          match.result = {
            winner: 'op', meHp: Math.ceil(match.me.hp), opHp: Math.ceil(match.op.hp), hits: match.me.hits,
            throws: match.me.throws, bestHitStreak: match.me.bestHitStreak, myFortHits: match.myFortHits,
            giants: match.me.giants, wind: match.wind, maxHeadwind: match.maxHeadwind, ticks: match.tick,
          };
        }
      }
      hiddenAt = 0;
      if (screen === 'fight' && match) { lastFrame = performance.now(); cancelAnimationFrame(rafId); rafId = requestAnimationFrame(loop); }
    } else if (!hiddenAt) {
      hiddenAt = Date.now();
    }
  }
  document.addEventListener('visibilitychange', () => onVisible(!document.hidden));
  onAppActiveChange(onVisible);

  // ---------- open / close ----------
  let myLookCache = null;
  function refreshLook() { myLookCache = buildLook(store.state.eq, 'green', store.state); }

  function openOverlay() {
    if (!enabled) return;
    open = true;
    refreshLook();
    root.hidden = false;
    tracker.setPvpOpen(true);
    opp = null;
    showScreen('entry');
  }
  function closeOverlay() {
    if (match && (match.phase === 'fight' || match.phase === 'sudden') && !practice) {
      if (!window.confirm(t('pvp.confirmForfeit'))) return;
      match.phase = 'end';
      match.result = { winner: 'op', meHp: Math.ceil(match.me.hp), opHp: Math.ceil(match.op.hp), hits: match.me.hits, throws: match.me.throws, bestHitStreak: match.me.bestHitStreak, myFortHits: match.myFortHits, giants: match.me.giants, wind: match.wind, maxHeadwind: match.maxHeadwind, ticks: match.tick };
      onDuelEnd();
    }
    cancelAnimationFrame(rafId);
    open = false;
    match = null;
    root.hidden = true;
    tracker.setPvpOpen(false);
  }
  el.hudBtn.addEventListener('click', openOverlay);
  el.close.addEventListener('click', closeOverlay);
  el.startBot.addEventListener('click', () => startDuel(false));
  el.startPractice.addEventListener('click', () => startDuel(true));
  el.openStats.addEventListener('click', () => showScreen('stats'));

  window.addEventListener('keydown', (e) => {
    if (!open || screen !== 'fight' || !match) return;
    if (e.key === 'ArrowLeft' || e.key === 'a') queue(SIM.CODE.MOVE_L);
    if (e.key === 'ArrowRight' || e.key === 'd') queue(SIM.CODE.MOVE_R);
    if (e.key === 's' || e.key === 'ArrowDown') { queue(SIM.CODE.DUCK_ON); el.btnDuck.classList.add('on'); }
    if (e.key === ' ' && !kbThrowHeld) { kbThrowHeld = true; queue(SIM.CODE.THROW_START); } // desktop debug: space = throw button
  });
  window.addEventListener('keyup', (e) => {
    if (e.key === 's' || e.key === 'ArrowDown') { queue(SIM.CODE.DUCK_OFF); el.btnDuck.classList.remove('on'); }
    if (e.key === ' ' && kbThrowHeld) { kbThrowHeld = false; queue(SIM.CODE.THROW_RELEASE); }
  });

  return {
    open: openOverlay,
    close: closeOverlay,
    isOpen: () => open,
    setEnabled(v) { enabled = v; renderHudBadge(); },
    setPressureSource(getP, getS) { getPressure = getP; getSource = getS; },
    relabel() { if (open) showScreen(screen); },
    // QA hooks (PVP-SPEC.md §11 acceptance checklist: "тест через __sb.pvp: forceWin, setHp, setWind")
    get match() { return match; },
    get opp() { return opp; },
    get lastResult() { return lastResult; },
    forceWin() { if (match) { if (match.phase === 'count') match.phase = 'fight'; match.me.hp = 100; match.op.hp = 0; SIM.tick(match, []); } },
    setHp(meHp, opHp) { if (match) { match.me.hp = meHp; match.op.hp = opHp; } },
    setWind(v) { if (match) { match.wind = v; match._calm = false; } },
    run(sec) { const n = Math.round(sec * SIM.TICK_HZ); for (let i = 0; i < n && match?.phase !== 'end'; i++) SIM.tick(match, []); updateFightHud(); updateThrowRing(); draw(); },
  };
}
