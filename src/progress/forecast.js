// Candle forecasts (v1.075): «Следующая свеча 5м будет ЗЕЛЁНОЙ ▲ или КРАСНОЙ ▼?»
//
// Rules
//  • Horizons 1м 5м 15м 1ч 4ч 1д, candles UTC-aligned like exchange klines.
//  • Only the NEXT candle can be predicted; entries close exactly at its open. One prediction per
//    horizon per candle → at most 2 per horizon (one running + one queued).
//  • Opening needs a live source (never DEMO), a visible page and a known exchange clock:
//    "now" = Date.now() + offset learned from live trade timestamps, so moving the phone's
//    clock can't reopen a candle that has already started.
//  • Resolution = the candle's own open vs close from REST klines (Binance → data-api.binance.vision
//    → Bybit), 2–3 s after close, or on the next launch. Green if close > open, red if close < open,
//    void if |close − open| / open < 0.01 %. The kline source is the truth for everyone ("по свечам
//    Binance"), regardless of the display source.
//  • Live progress: candle open from REST once it opens (fallback: first live tick after open).
//
// Storage (profile v2 `f`):
//   candle entry  ['c', h, dir 'u'|'d', t0, open|null]  — t0 + horizon fully identify the candle
//   legacy entry  [h, dir, entryPrice, entryMs, src]    — v1.06 time forecasts, resolved under the
//                                                         old rules until they drain (code below)

export const HORIZONS = [
  { id: '1m', ms: 60_000, xp: 2, bucket: 'fcShort', binance: '1m', bybit: '1' },
  { id: '5m', ms: 300_000, xp: 5, bucket: 'fcShort', binance: '5m', bybit: '5' },
  { id: '15m', ms: 900_000, xp: 10, bucket: 'fcShort', binance: '15m', bybit: '15' },
  { id: '1h', ms: 3_600_000, xp: 20, bucket: 'fcLong', binance: '1h', bybit: '60' },
  { id: '4h', ms: 14_400_000, xp: 40, bucket: 'fcLong', binance: '4h', bybit: '240' },
  { id: '1d', ms: 86_400_000, xp: 80, bucket: 'fcLong', binance: '1d', bybit: 'D' },
];
export const TIE_FRACTION = 0.0001; // 0.01 %
const TICK_MS = 1000;
const RESOLVE_DELAY_MS = 2500;      // wait for the exchange to close the candle
const REST_RETRY_NOTYET_MS = 5000;
const REST_RETRY_ERROR_MS = 60_000;
const VOID_AFTER_MS = 7 * 86_400_000;
const MAX_ENTRIES = 18;             // 6 × (running + queued) + up to 6 draining legacy
const MINUTE = 60_000;

export const isCandle = (f) => f[0] === 'c';
export const candleStart = (ms, h) => Math.floor(ms / HORIZONS[h].ms) * HORIZONS[h].ms;

// ---------- REST ----------
async function getJson(url, fetchImpl) {
  const res = await fetchImpl(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json();
}

// Candle [t0, t0 + H): { status:'ok', open, close, closed } | { status:'notyet' } | { status:'error' }.
// `closed` is true only when the exchange already returned the following candle.
export async function fetchCandle(h, t0, fetchImpl = fetch) {
  const hz = HORIZONS[h];
  let sawNotYet = false;
  for (const host of ['api.binance.com', 'data-api.binance.vision']) {
    try {
      const rows = await getJson(`https://${host}/api/v3/klines?symbol=BTCUSDT&interval=${hz.binance}&startTime=${t0}&limit=2`, fetchImpl);
      if (!Array.isArray(rows)) throw new Error('payload');
      if (!rows.length || rows[0][0] !== t0) { sawNotYet = true; continue; }
      return { status: 'ok', open: +rows[0][1], close: +rows[0][4], closed: rows.length >= 2, via: host };
    } catch { /* blocked / offline → next source */ }
  }
  try {
    const body = await getJson(`https://api.bybit.com/v5/market/kline?category=spot&symbol=BTCUSDT&interval=${hz.bybit}&start=${t0}&end=${t0 + hz.ms}&limit=2`, fetchImpl);
    const list = body?.result?.list;
    if (body?.retCode !== 0 || !Array.isArray(list)) throw new Error('payload');
    const row = list.find((r) => +r[0] === t0); // newest first
    if (!row) return { status: 'notyet' };
    return { status: 'ok', open: +row[1], close: +row[4], closed: list.some((r) => +r[0] === t0 + hz.ms), via: 'bybit' };
  } catch { /* fall through */ }
  return { status: sawNotYet ? 'notyet' : 'error' };
}

// Legacy (v1.06) helper: close of the 1-minute candle containing `expiryMs`.
export async function klineCloseAt(expiryMs, fetchImpl = fetch) {
  const minute = Math.floor(expiryMs / MINUTE) * MINUTE;
  const r = await fetchCandle(0, minute, fetchImpl);
  if (r.status === 'ok' && r.closed) return { status: 'ok', price: r.close, via: r.via };
  return { status: r.status === 'error' ? 'error' : 'notyet' };
}

export function createForecasts({ store, tracker, market, enabled, hooks = {}, fetchImpl = globalThis.fetch?.bind(globalThis) }) {
  const sessionWall = Date.now();
  const sessionMono = performance.now();
  const monoNow = () => sessionWall + (performance.now() - sessionMono);
  const nextTry = new Map();       // entry key → wall ms of next REST attempt
  const firstFail = new Map();     // entry key → wall ms of first network failure
  const openFetched = new Set();   // candle keys whose REST open we already have
  let clockOffset = null;          // exchange time − local time (ms), from live trades
  let busy = false;

  const p = () => store.state;
  const active = () => p().f;
  const keyOf = (f) => (isCandle(f) ? `c${f[1]}:${f[3]}` : `l${f[0]}:${f[3]}`);

  // ---------- exchange clock ----------
  market.on('trade', (t) => {
    if (t.exchange === 'demo' || !(t.ts > 0)) return;
    const off = t.ts - Date.now();
    clockOffset = clockOffset == null ? off : clockOffset + (off - clockOffset) * 0.1;
  });
  const serverNow = () => Date.now() + (clockOffset ?? 0);

  // ---------- opening ----------
  // State of horizon h for the UI and the entry check.
  function slot(h) {
    const now = serverNow();
    const H = HORIZONS[h].ms;
    const t0 = candleStart(now, h) + H; // next candle open = entry deadline
    let queued = null;
    let running = null;
    for (const f of active()) {
      if (!isCandle(f) || f[1] !== h) continue;
      if (f[3] === t0) queued = f;
      else if (f[3] <= now && now < f[3] + H) running = f;
    }
    const legacyBusy = active().some((f) => !isCandle(f) && f[0] === h);
    return {
      h, t0, t1: t0 + H, entryLeftMs: Math.max(0, t0 - now),
      queued: queued ? queued[2] : null, running: running ? running[2] : null, legacyBusy,
    };
  }

  function canOpen(h) {
    if (!enabled || !tracker.tracking || clockOffset == null) return false;
    const st = slot(h);
    return !st.queued && st.entryLeftMs > 0 && active().length < MAX_ENTRIES;
  }

  function open(h, dir) {
    if (!canOpen(h) || (dir !== 'u' && dir !== 'd')) return false;
    const q = p();
    q.f.push(['c', h, dir, slot(h).t0, null]);
    q.fh[h][0]++;
    tracker.rollDay();
    tracker.markActiveDay();
    tracker.changed();
    hooks.onChange?.();
    return true;
  }

  // ---------- resolution (shared by candle + legacy) ----------
  function settle(f, h, dir, result, info) {
    const q = p();
    const idx = q.f.indexOf(f);
    if (idx < 0) return;
    q.f.splice(idx, 1);
    tracker.rollDay();
    const hz = HORIZONS[h];
    const row = q.fh[h];
    let xp = 0;
    if (result === 'void') {
      row[4]++;
    } else if (result === 'win') {
      row[1]++;
      row[2]++;
      row[3] = Math.max(row[3], row[2]);
      xp = tracker.addXp(hz.xp, hz.bucket);
      if (q.fd[0] !== q.day) q.fd = [q.day, 0];
      q.fd[1] |= 1 << h;
    } else {
      row[2] = 0;
    }
    tracker.changed();
    hooks.onResolved?.({ h, dir, result, xp, ...info });
    hooks.onChange?.();
  }

  const candleResult = (dir, open, close) => {
    if (!(open > 0) || close === open || Math.abs(close - open) / open < TIE_FRACTION) return 'void';
    const green = close > open;
    return (dir === 'u') === green ? 'win' : 'loss';
  };

  async function tickCandle(f, now) {
    const [, h, dir, t0] = f;
    const H = HORIZONS[h].ms;
    const key = keyOf(f);
    if (now < t0) return; // queued
    // live progress: the candle's open (REST once, first live tick as a fallback)
    if (!openFetched.has(key) && (nextTry.get(`o${key}`) || 0) <= now) {
      nextTry.set(`o${key}`, now + 10_000);
      const r = await fetchCandle(h, t0, fetchImpl);
      if (r.status === 'ok') {
        openFetched.add(key);
        if (f[4] !== r.open) { f[4] = r.open; store.markDirty(); }
      }
    }
    if (f[4] == null && tracker.live && market.getPrice() > 0) f[4] = market.getPrice();
    if (now < t0 + H + RESOLVE_DELAY_MS) return;
    if ((nextTry.get(key) || 0) > now) return;
    const r = await fetchCandle(h, t0, fetchImpl);
    if (r.status === 'ok' && r.closed) {
      settle(f, h, dir, candleResult(dir, r.open, r.close), { open: r.open, close: r.close, t0, how: r.via });
      return;
    }
    if (r.status === 'error') {
      if (!firstFail.has(key)) firstFail.set(key, now);
      nextTry.set(key, now + REST_RETRY_ERROR_MS);
      if (Date.now() - (t0 + H) > VOID_AFTER_MS) settle(f, h, dir, 'void', { t0, how: 'expired' });
    } else {
      nextTry.set(key, now + REST_RETRY_NOTYET_MS);
    }
  }

  // v1.06 time forecasts: entry price vs the price at entry + horizon (old rules).
  function legacyLivePrice(code) {
    const src = market.getSource();
    const codes = { AGG: 'A', BINANCE: 'B', BYBIT: 'Y', COINBASE: 'C' };
    if (codes[src] === code) return market.getPrice();
    const v = market.getVenues()[{ B: 'binance', Y: 'bybit', C: 'coinbase' }[code]];
    return v?.alive ? v.price : market.getPrice();
  }

  async function tickLegacy(f) {
    const [h, dir, entry, at, code] = f;
    const expiry = at + HORIZONS[h].ms;
    const key = keyOf(f);
    const legacyResult = (exit) => (exit == null || Math.abs(exit - entry) / entry < TIE_FRACTION ? 'void'
      : (dir === 'u' ? exit > entry : exit < entry) ? 'win' : 'loss');
    if (expiry > sessionWall) {
      const mono = monoNow();
      if (mono < expiry) return;
      const px = tracker.live ? legacyLivePrice(code) : null;
      if (px > 0 && mono - expiry <= 90_000) { settle(f, h, dir, legacyResult(px), { how: 'live' }); return; }
      if (mono - expiry <= 90_000) return;
    }
    if ((nextTry.get(key) || 0) > Date.now()) return;
    nextTry.set(key, Date.now() + REST_RETRY_ERROR_MS);
    const r = await klineCloseAt(expiry, fetchImpl);
    if (r.status === 'ok') settle(f, h, dir, legacyResult(r.price), { how: `rest:${r.via}` });
    else if (r.status === 'error' && Date.now() - at > VOID_AFTER_MS + HORIZONS[h].ms) settle(f, h, dir, 'void', { how: 'expired' });
  }

  async function tick() {
    if (!enabled || !store.isLeader || busy || !active().length) return;
    busy = true;
    try {
      const now = serverNow();
      for (const f of [...active()]) {
        if (isCandle(f)) await tickCandle(f, now);
        else await tickLegacy(f);
      }
    } finally {
      busy = false;
    }
  }

  const timer = setInterval(tick, TICK_MS);
  setTimeout(tick, 1500); // offline resolution shortly after launch

  // ---------- UI snapshot (allocates; called ≤ 4 Hz) ----------
  function list() {
    const now = serverNow();
    const px = market.getPrice();
    return active().map((f) => {
      if (isCandle(f)) {
        const [, h, dir, t0, open] = f;
        const H = HORIZONS[h].ms;
        const state = now < t0 ? 'queued' : now < t0 + H ? 'running' : 'resolving';
        const winning = state === 'running' && open > 0 && px > 0 && Math.abs(px - open) / open >= TIE_FRACTION
          ? (dir === 'u') === (px > open) : null;
        return {
          kind: 'candle', h, id: HORIZONS[h].id, dir, t0, t1: t0 + H, open, state, winning,
          remainingMs: state === 'queued' ? t0 - now : Math.max(0, t0 + H - now),
        };
      }
      const [h, dir, entry, at] = f;
      const expiry = at + HORIZONS[h].ms;
      const winning = px > 0 && Math.abs(px - entry) / entry >= TIE_FRACTION ? (dir === 'u' ? px > entry : px < entry) : null;
      return {
        kind: 'legacy', h, id: HORIZONS[h].id, dir, open: entry, t0: at, t1: expiry,
        state: now < expiry ? 'running' : 'resolving', winning, remainingMs: Math.max(0, expiry - now),
      };
    });
  }

  return {
    open,
    canOpen,
    slot,
    list,
    tick,
    serverNow,
    get clockKnown() { return clockOffset != null; },
    isActive: (h) => active().some((f) => (isCandle(f) ? f[1] === h : f[0] === h)),
    stop() { clearInterval(timer); },
  };
}
