// Progress tracker (V105-CLIENT.md §2, §5): watch time, days/streaks, side of the day, round
// guesses, "seen" market events, XP with daily caps, achievements. Only counts while the
// source is live (never DEMO/null), the page is visible, test URL params are absent (unless
// ?progtest=1) and this tab holds the multi-tab lock. Durations use monotonic time only.
import { utcDayOf } from './store.js?v=6561619d';
import { checkAll, RARITY_XP } from './achievements.js?v=6561619d';
import { isGuessLocked, roundSig } from './guess.js?v=6561619d';

const TICK_MS = 1000;
const MAX_STEP_S = 1.5;
const ACTIVE_DAY_WATCH_S = 300;
const SIDE_PROMPT_AFTER_S = 5;
const EARLY_GUESS_S = 10;
const ROUND_MIN_S = 30;
const ROUND_VISIBLE_SHARE = 0.6;
const XP = { day: 20, minute: 1, round: 3, guess: 5, guessWin: 10 };
// Daily XP caps per UTC day: xd = [watch, guess, round, forecastShort, forecastLong].
// Long horizons (1ч/4ч/24ч) have their own bucket so farming 1-minute forecasts can never
// crowd out the 24ч payout (80): 160 = one of each long horizon + room for a few 1ч.
const XP_CAP = { watch: 30, guess: 60, round: 30, fcShort: 60, fcLong: 160 };
const XD_INDEX = { watch: 0, guess: 1, round: 2, fcShort: 3, fcLong: 4 };
const LIVE_SOURCES = new Set(['AGG', 'BINANCE', 'BYBIT', 'COINBASE']);

export function createTracker({ store, round, enabled, isVisibleExtra = () => true, hooks = {} }) {
  let live = false;
  let dayOffset = 0;              // QA: __sb.progress.fakeDay(+n)
  let prevTick = performance.now();
  let watchFrac = 0;              // sub-second watch time (not persisted)
  let minuteFrac = 0;             // seconds toward the next watch-XP minute
  let dayLiveSeconds = 0;         // visible live seconds this session in the current day (side prompt)
  let sidePromptShown = false;
  // current round bookkeeping (monotonic)
  const rnd = { sig: null, startMono: 0, visibleS: 0, eligible: false, guessMono: 0, giantSides: new Set() };

  const p = () => store.state;
  const today = () => Math.max(utcDayOf(Date.now() + dayOffset * 86_400_000), p().day);
  const visible = () => !document.hidden && isVisibleExtra();
  const tracking = () => enabled && live && visible() && store.isLeader;

  // ---------- XP / achievements ----------
  function addXp(amount, bucket) {
    const q = p();
    if (bucket) {
      const i = XD_INDEX[bucket];
      const room = XP_CAP[bucket] - q.xd[i];
      amount = Math.max(0, Math.min(amount, room));
      q.xd[i] += amount;
    }
    q.xp += amount;
    return amount;
  }

  function checkAchievements(ctx) {
    const q = p();
    for (const def of checkAll(q, ctx)) {
      q.a[def.id] = q.day;
      const xp = addXp(RARITY_XP[def.rarity]);
      hooks.onUnlock?.(def, xp);
    }
  }

  function changed(ctx) {
    checkAchievements(ctx);
    store.markDirty();
  }

  // ---------- day rollover / active day ----------
  function rollDay() {
    const q = p();
    const d = today();
    if (d <= q.day) return false;
    q.day = d;
    q.wd = 0;
    q.xd = [0, 0, 0, 0, 0];
    if (q.st[2] < d - 1) q.st[0] = 0; // streak broken
    dayLiveSeconds = 0;
    sidePromptShown = false;
    return true;
  }

  function markActiveDay() {
    const q = p();
    const d = q.day;
    if (q.st[2] === d) return;
    q.st[0] = q.st[2] === d - 1 ? q.st[0] + 1 : 1;
    q.st[2] = d;
    q.st[1] = Math.max(q.st[1], q.st[0]);
    addXp(XP.day);
  }

  // ---------- tick: watch time ----------
  function tick() {
    const now = performance.now();
    const dt = Math.min(MAX_STEP_S, Math.max(0, (now - prevTick) / 1000));
    prevTick = now;
    let dirty = rollDay();
    if (tracking()) {
      const q = p();
      watchFrac += dt;
      const whole = Math.floor(watchFrac);
      if (whole > 0) {
        watchFrac -= whole;
        q.w += whole;
        q.wd += whole;
        dirty = true;
      }
      minuteFrac += dt;
      if (minuteFrac >= 60) {
        minuteFrac -= 60;
        addXp(XP.minute, 'watch');
      }
      if (q.wd >= ACTIVE_DAY_WATCH_S) markActiveDay();
      rnd.visibleS += dt;
      dayLiveSeconds += dt;
      if (!sidePromptShown && dayLiveSeconds >= SIDE_PROMPT_AFTER_S && q.sd?.[0] !== q.day) {
        sidePromptShown = true;
        hooks.onSidePrompt?.();
      }
    }
    if (dirty) changed();
  }

  // ---------- rounds & guesses ----------
  function missPendingGuess() {
    const q = p();
    if (!q.pg) return;
    q.g[2] = 0; // an unresolved guess is a miss (no hiding losing guesses by leaving)
    q.pg = null;
  }

  function onRoundEvents(events) {
    if (!enabled) return;
    for (const ev of events) {
      const q = p();
      if (ev.type === 'start') {
        if (q.pg) {
          missPendingGuess();
          store.markDirty();
        }
        rnd.sig = roundSig(round.state);
        rnd.startMono = performance.now();
        rnd.visibleS = 0;
        rnd.guessMono = 0;
        rnd.giantSides = new Set();
        // restarts (DEMO↔live, user source switch) and rounds begun off-live don't count
        rnd.eligible = live && ev.reason !== 'restart';
        hooks.onGuessState?.();
      } else if (ev.type === 'victory') {
        if (!rnd.sig) continue;
        const durS = (performance.now() - rnd.startMono) / 1000;
        const visibleEnough = rnd.visibleS >= ROUND_VISIBLE_SHARE * durS;
        let dirty = false;
        if (rnd.eligible && live && durS >= ROUND_MIN_S && visibleEnough) {
          q.rw++;
          addXp(XP.round, 'round');
          dirty = true;
        }
        let ctx;
        if (q.pg && q.pg[0] === rnd.sig) {
          const side = q.pg[1];
          const won = rnd.eligible && visibleEnough && (ev.winner === 'green' ? 'g' : 'r') === side;
          if (won) {
            q.g[1]++;
            q.g[2]++;
            q.g[3] = Math.max(q.g[3], q.g[2]);
            addXp(XP.guessWin, 'guess');
            ctx = { guessWon: true, side, giantSides: rnd.giantSides };
          } else {
            q.g[2] = 0;
          }
          q.pg = null;
          dirty = true;
          hooks.onGuessResult?.(won);
        }
        rnd.sig = null;
        if (dirty) changed(ctx);
        hooks.onGuessState?.();
      }
    }
  }

  // UI state for the guess bar.
  function guessState() {
    const q = p();
    const st = round.state;
    const mine = q.pg && q.pg[0] === rnd.sig ? q.pg[1] : null;
    if (!enabled) return { mode: 'off' };
    if (!live) return { mode: 'demo' };
    if (st.phase !== 'live' || !rnd.sig) return { mode: 'wait', roundNo: st.roundNo };
    if (mine) return { mode: 'done', side: mine, roundNo: st.roundNo };
    if (isGuessLocked(st)) return { mode: 'locked', roundNo: st.roundNo };
    if (!visible()) return { mode: 'wait', roundNo: st.roundNo };
    return { mode: 'open', roundNo: st.roundNo };
  }

  function guess(side) {
    if (guessState().mode !== 'open' || !tracking()) return false;
    const q = p();
    q.pg = [rnd.sig, side, Date.now()];
    q.g[0]++;
    rnd.guessMono = performance.now();
    rnd.giantSides = new Set(); // only giants after the guess count for whale_* achievements
    if (rnd.eligible && (rnd.guessMono - rnd.startMono) / 1000 <= EARLY_GUESS_S) q.g[4]++;
    addXp(XP.guess, 'guess');
    markActiveDay();
    changed();
    hooks.onGuessState?.();
    return true;
  }

  // ---------- market events ----------
  function onStatus(st) {
    live = LIVE_SOURCES.has(st.source);
    hooks.onGuessState?.();
  }

  function onBigprint(bp) {
    if (!tracking()) return;
    const q = p();
    if (bp.tier === 'giant') {
      q.gi++;
      if (rnd.guessMono) rnd.giantSides.add(bp.side === 'buy' ? 'g' : 'r');
    }
    if (bp.kind === 'whale') q.wh++;
    if (bp.kind === 'liquidation') q.lq++;
    if (bp.usd >= 1_000_000 && bp.synthetic === false) q.av++;
    changed();
  }

  // ---------- side of the day ----------
  function sideState() {
    const q = p();
    const picked = q.sd?.[0] === q.day ? q.sd[1] : null;
    return { picked, canChange: !picked || q.sd[2] < 1 };
  }

  function pickSide(side) {
    if (!enabled) return false;
    rollDay();
    const q = p();
    const d = q.day;
    if (q.sd?.[0] === d) {
      if (q.sd[1] === side || q.sd[2] >= 1) return false;
      q.sd = [d, side, q.sd[2] + 1];
      q.ly = [side, 1]; // switching sides resets loyalty
    } else {
      const yesterdaySame = q.sd?.[0] === d - 1 && q.sd[1] === side && q.ly?.[0] === side;
      q.ly = yesterdaySame ? [side, q.ly[1] + 1] : [side, 1];
      q.sd = [d, side, 0];
    }
    changed();
    return true;
  }

  // ---------- lifecycle ----------
  if (enabled) {
    // A guess left open by a previous session counts as a miss.
    if (p().pg) {
      missPendingGuess();
      store.markDirty();
    }
    rollDay();
  }
  const timer = setInterval(tick, TICK_MS);

  return {
    onStatus,
    onBigprint,
    onRoundEvents,
    guess,
    guessState,
    pickSide,
    sideState,
    get live() { return live; },
    get tracking() { return tracking(); },
    // QA helpers
    fakeDay(n = 1) {
      dayOffset += n;
      if (rollDay()) changed();
    },
    today,
    // QA: re-run achievement checks after counters were edited by hand
    recheck() { changed(); },
    // shared with the forecast module
    addXp,
    changed,
    rollDay,
    markActiveDay,
    get visible() { return visible(); },
    stop() { clearInterval(timer); },
    _round: rnd,
  };
}
