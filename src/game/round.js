// Round state machine — pure logic, no rendering.
//
// Convention: borderT ∈ [0, 1] is the border's vertical position as a fraction of the field
// measured from the TOP. 0 = RED end zone (top) reached → GREEN wins; 1 = GREEN end zone
// (bottom) reached → RED wins. Price at round center → 0.5. Price up → borderT decreases.
//   frontLineY = Fmin + borderT * (Fmax - Fmin)        (DESIGN.md §4)
//
// Phases: 'waiting' (no price yet) → 'live' → 'victory' (celebration, border pinned) → 'live' (new round)
//
// Usage: const round = createRound(opts); each frame: const events = round.update(price, dtSec);
// events: { type: 'start', center, low, high, halfRange, roundNo, reason:'first'|'after-victory'|'restart' }
//         { type: 'victory', winner:'green'|'red', price, roundNo, score:{green,red} }

const SCORE_KEYS = { live: 'sb.score.v1', demo: 'sb.score.demo.v1' };
const EASE_RATE = 3.5;              // 1/s — exponential approach of borderT to target
const MAX_SPEED = 0.6;              // max borderT change per second (never teleports)
const VOL_SAMPLE_MS = 1000;
const VOL_WINDOW = 900;             // keep 15 min of 1 s samples
const VOL_MIN_SAMPLES = 120;        // 2 min of data before trusting the estimate
const VOL_LAG = 5;                  // 5 s returns: robust to bid/ask bounce in 1 s prints
// Driftless walk from the centre of ±h exits after h²/σ² on average → h = σ·√T.
// Real prices trend/cluster, so the realised median lands at roughly 5–12 min.
const TARGET_ROUND_SEC = 480;

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

function defaultStorage() {
  try { return globalThis.localStorage ?? null; } catch { return null; }
}

function loadScore(storage, key) {
  try {
    const s = JSON.parse(storage?.getItem(key) || 'null');
    if (s && Number.isFinite(s.green) && Number.isFinite(s.red)) return { green: s.green, red: s.red };
  } catch { /* storage blocked or corrupt */ }
  return { green: 0, red: 0 };
}

function saveScore(storage, key, score) {
  try { storage?.setItem(key, JSON.stringify(score)); } catch { /* ignore */ }
}

// Largest "nice" step giving at most maxCount markers across `span`.
export function niceStep(span, maxCount = 7) {
  const steps = [1, 2, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000];
  for (const s of steps) if (span / s <= maxCount) return s;
  return steps[steps.length - 1];
}

// Round-number price levels strictly inside (low, high), with their borderT position.
export function markerLevels(low, high, maxCount = 7) {
  if (!(high > low)) return [];
  const step = niceStep(high - low, maxCount);
  const out = [];
  for (let p = Math.ceil(low / step) * step; p < high; p += step) {
    if (p > low) out.push({ price: p, t: (high - p) / (high - low), major: p % (step * 2) === 0 });
  }
  return out;
}

// Price-axis sign levels for the whole canvas (DESIGN.md §6): step N from AXIS_STEPS so
// that signs are ≥ minGap px apart; the mapping is linear, low → yLow, high → yHigh.
// Signs within `skipTop` px of the top or `skipBottom` px of the bottom are dropped.
const AXIS_STEPS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000];
export function axisLevels({ low, high, yLow, yHigh, height, minGap = 22, skipTop = 4, skipBottom = 12 }) {
  if (!(high > low) || !(yLow > yHigh)) return [];
  const pxPerUsd = (yLow - yHigh) / (high - low);
  const step = AXIS_STEPS.find((s) => s * pxPerUsd >= minGap) ?? AXIS_STEPS[AXIS_STEPS.length - 1];
  const priceAt = (y) => high + (yHigh - y) / pxPerUsd;
  const out = [];
  const pMin = priceAt(height - skipBottom);
  const pMax = priceAt(skipTop);
  for (let p = Math.ceil(pMin / step) * step; p <= pMax; p += step) {
    out.push({ price: p, y: Math.round(yHigh + (high - p) * pxPerUsd), label: signLabel(p) });
  }
  return out;
}

// Sign text: ≤5 glyphs. Full integer if ≤5 digits, "67k" on round thousands, "101k" ≥ 100 000.
export function signLabel(p) {
  const v = Math.round(p);
  if (v >= 100000) return `${Math.floor(v / 1000)}k`;
  if (v % 1000 === 0 && v !== 0) return `${v / 1000}k`;
  return String(v);
}

export function createRound({
  halfRange = 100,           // $ — fixed half-range, also the adaptive fallback until enough samples
  adaptive = true,           // derive half-range from recent realized volatility at each round start
  minHalf = 40,
  maxHalf = 600,
  celebrationMs = 3200,
  scoreBucket = 'live',      // 'live' | 'demo' — separate persisted tallies
  storage = defaultStorage(),
} = {}) {
  const state = {
    phase: 'waiting',
    center: 0,
    halfRange,
    low: 0,
    high: 0,
    price: null,
    borderT: 0.5,
    targetT: 0.5,
    winner: null,
    victoryAt: 0,
    roundStartedAt: 0,
    roundNo: 0,
    scoreBucket,
    score: loadScore(storage, SCORE_KEYS[scoreBucket]),
  };
  const volSamples = [];
  let lastVolSample = 0;

  function sampleVolatility(price, now) {
    if (now - lastVolSample < VOL_SAMPLE_MS) return;
    lastVolSample = now;
    volSamples.push(price);
    if (volSamples.length > VOL_WINDOW) volSamples.shift();
  }

  // Realized $ volatility per √s from overlapping 5 s differences; null until enough data.
  function realizedVolPerSqrtSec() {
    if (volSamples.length < VOL_MIN_SAMPLES) return null;
    let sumSq = 0;
    let n = 0;
    for (let i = VOL_LAG; i < volSamples.length; i++) {
      const r = volSamples[i] - volSamples[i - VOL_LAG];
      sumSq += r * r;
      n++;
    }
    return Math.sqrt(sumSq / n / VOL_LAG);
  }

  function pickHalfRange() {
    if (!adaptive) return halfRange;
    const vol = realizedVolPerSqrtSec();
    if (vol == null) return clamp(halfRange, minHalf, maxHalf);
    const h = Math.round((vol * Math.sqrt(TARGET_ROUND_SEC)) / 5) * 5;
    return clamp(h, minHalf, maxHalf);
  }

  function startRound(price, now, reason) {
    state.phase = 'live';
    state.center = price;
    state.halfRange = pickHalfRange();
    state.low = price - state.halfRange;
    state.high = price + state.halfRange;
    state.winner = null;
    state.roundStartedAt = now;
    state.roundNo++;
    // borderT is NOT reset: it eases from wherever it is (e.g. an end zone) back toward 0.5.
    return {
      type: 'start', center: price, low: state.low, high: state.high,
      halfRange: state.halfRange, roundNo: state.roundNo, reason,
    };
  }

  function priceToT(price) {
    return clamp((state.high - price) / (state.high - state.low), 0, 1);
  }

  function ease(dt) {
    const diff = state.targetT - state.borderT;
    let step = diff * (1 - Math.exp(-EASE_RATE * dt));
    const maxStep = MAX_SPEED * dt;
    step = clamp(step, -maxStep, maxStep);
    state.borderT += step;
  }

  function update(price, dt, now = Date.now()) {
    const events = [];
    dt = clamp(dt || 0, 0, 0.25); // survive tab-switch pauses
    if (price > 0) {
      state.price = price;
      sampleVolatility(price, now);
    }

    if (state.phase === 'waiting') {
      if (state.price > 0) events.push(startRound(state.price, now, 'first'));
      return events;
    }

    if (state.phase === 'live' && state.price != null) {
      if (state.price >= state.high || state.price <= state.low) {
        const winner = state.price >= state.high ? 'green' : 'red';
        state.phase = 'victory';
        state.winner = winner;
        state.victoryAt = now;
        state.score[winner]++;
        saveScore(storage, SCORE_KEYS[state.scoreBucket], state.score);
        state.targetT = winner === 'green' ? 0 : 1;
        events.push({ type: 'victory', winner, price: state.price, roundNo: state.roundNo, score: { ...state.score } });
      } else {
        state.targetT = priceToT(state.price);
      }
    } else if (state.phase === 'victory' && now - state.victoryAt >= celebrationMs) {
      events.push(startRound(state.price, now, 'after-victory'));
      state.targetT = priceToT(state.price);
    }

    ease(dt);
    return events;
  }

  return {
    update,
    // New round on current price without scoring (e.g. after a DEMO↔live source switch).
    restart(price = state.price, now = Date.now()) {
      if (!(price > 0)) return null;
      state.price = price;
      const ev = startRound(price, now, 'restart');
      state.targetT = priceToT(price);
      return ev;
    },
    // Change range policy / score bucket (applies from the next round start).
    configure(opts = {}) {
      if (opts.halfRange != null) halfRange = opts.halfRange;
      if (opts.adaptive != null) adaptive = opts.adaptive;
      if (opts.minHalf != null) minHalf = opts.minHalf;
      if (opts.clearVolatility) volSamples.length = 0;
      if (opts.scoreBucket && opts.scoreBucket !== state.scoreBucket && SCORE_KEYS[opts.scoreBucket]) {
        state.scoreBucket = opts.scoreBucket;
        state.score = loadScore(storage, SCORE_KEYS[opts.scoreBucket]);
      }
    },
    resetScore() {
      state.score = { green: 0, red: 0 };
      saveScore(storage, SCORE_KEYS[state.scoreBucket], state.score);
    },
    priceToT: (p) => (state.high > state.low ? priceToT(p) : 0.5),
    markers: (maxCount) => markerLevels(state.low, state.high, maxCount),
    // Progress toward each end zone in [0,1] — handy for HUD tension effects.
    progress() {
      const t = state.borderT;
      return { green: clamp((0.5 - t) * 2, 0, 1), red: clamp((t - 0.5) * 2, 0, 1) };
    },
    get state() { return state; },
    get volatility() { return realizedVolPerSqrtSec(); },
  };
}
