// Time-horizon forecasts (phase 5): "price higher / lower in 1м…24ч", free, XP only.
//
// Rules
//  • ≤ 1 active forecast per horizon (6 in parallel), no cancelling.
//  • Open only with a live source (never DEMO) on a visible page (tracker.tracking).
//  • Entry = the selected source's price at click time; expiry = stored entryMs + horizon.
//  • Resolution
//      – app running at expiry and live → live price of the entry source at expiry;
//      – otherwise → public REST 1-minute kline close for the expiry minute
//        (Binance → data-api.binance.vision → Bybit). AGG entries resolved this way use the
//        Binance/Bybit USDT close: a few-dollar basis vs the AGG mean is accepted.
//      – |Δ| < 0.01 % → void (no XP, streak unchanged).
//      – REST unreachable → stays pending, retried; void after 7 days of failures.
//  • Anti-cheese: in-session expiry uses a monotonic clock (changing the system clock can't
//    fast-forward), and REST only returns a *closed* candle once the exchange's own clock
//    passed it, so a forward-set clock just leaves the forecast pending.

export const HORIZONS = [
  { id: '1m', ms: 60_000, xp: 2, bucket: 'fcShort' },
  { id: '5m', ms: 300_000, xp: 5, bucket: 'fcShort' },
  { id: '15m', ms: 900_000, xp: 10, bucket: 'fcShort' },
  { id: '1h', ms: 3_600_000, xp: 20, bucket: 'fcLong' },
  { id: '4h', ms: 14_400_000, xp: 40, bucket: 'fcLong' },
  { id: '24h', ms: 86_400_000, xp: 80, bucket: 'fcLong' },
];
export const TIE_FRACTION = 0.0001; // 0.01 %
const TICK_MS = 1000;
const LIVE_GRACE_MS = 90_000;       // at expiry without a live price → go to REST after this
const REST_RETRY_MS = 60_000;
const VOID_AFTER_MS = 7 * 86_400_000;
const SRC_CODE = { AGG: 'A', BINANCE: 'B', BYBIT: 'Y', COINBASE: 'C' };
const CODE_VENUE = { B: 'binance', Y: 'bybit', C: 'coinbase' };
const MINUTE = 60_000;

// entry f = [h, dir 'u'|'d', entryPrice, entryMs, srcCode]
const H = 0;
const DIR = 1;
const ENTRY = 2;
const AT = 3;
const SRC = 4;

// ---------- REST: close of the 1-minute candle containing `expiryMs` ----------
// Asking for 2 candles from that minute tells us whether it is closed: the exchange only
// returns the following candle once its own clock is past the minute.
async function binanceClose(host, minute, fetchImpl) {
  const url = `https://${host}/api/v3/klines?symbol=BTCUSDT&interval=1m&startTime=${minute}&limit=2`;
  const res = await fetchImpl(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`${host} ${res.status}`);
  const rows = await res.json();
  if (!Array.isArray(rows)) throw new Error(`${host} bad payload`);
  if (rows.length < 2 || rows[0][0] !== minute) return { status: 'notyet' };
  return { status: 'ok', price: +rows[0][4], via: host };
}

async function bybitClose(minute, fetchImpl) {
  const url = `https://api.bybit.com/v5/market/kline?category=spot&symbol=BTCUSDT&interval=1&start=${minute}&end=${minute + MINUTE}&limit=2`;
  const res = await fetchImpl(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`bybit ${res.status}`);
  const body = await res.json();
  const list = body?.result?.list;
  if (body?.retCode !== 0 || !Array.isArray(list)) throw new Error('bybit bad payload');
  const row = list.find((r) => +r[0] === minute);          // list is newest-first
  const next = list.find((r) => +r[0] === minute + MINUTE);
  if (!row || !next) return { status: 'notyet' };
  return { status: 'ok', price: +row[4], via: 'bybit' };
}

export async function klineCloseAt(expiryMs, fetchImpl = fetch) {
  const minute = Math.floor(expiryMs / MINUTE) * MINUTE;
  let sawNotYet = false;
  const tries = [
    () => binanceClose('api.binance.com', minute, fetchImpl),
    () => binanceClose('data-api.binance.vision', minute, fetchImpl),
    () => bybitClose(minute, fetchImpl),
  ];
  for (const attempt of tries) {
    try {
      const r = await attempt();
      if (r.status === 'ok' && r.price > 0) return r;
      sawNotYet = true;
    } catch { /* blocked / offline: try the next source */ }
  }
  return { status: sawNotYet ? 'notyet' : 'error' };
}

export function createForecasts({ store, tracker, market, enabled, hooks = {}, fetchImpl = globalThis.fetch?.bind(globalThis) }) {
  const sessionWall = Date.now();
  const sessionMono = performance.now();
  const monoNow = () => sessionWall + (performance.now() - sessionMono); // clock-change proof
  const lastRestTry = new Map();   // entryMs → wall ms of last REST attempt
  const firstRestFail = new Map(); // entryMs → wall ms of first network failure
  let busy = false;

  const p = () => store.state;
  const active = () => p().f;

  // Live price comparable to the entry source.
  function livePriceFor(code) {
    const src = market.getSource();
    if (SRC_CODE[src] === code) return market.getPrice();
    const venues = market.getVenues();
    if (code === 'A') {
      let sum = 0;
      let n = 0;
      for (const v of Object.values(venues)) if (v.alive && v.price > 0) { sum += v.price; n++; }
      return n ? sum / n : null;
    }
    const v = venues[CODE_VENUE[code]];
    return v?.alive ? v.price : null;
  }

  function canOpen(h) {
    return enabled && tracker.tracking && !active().some((f) => f[H] === h) && market.getPrice() > 0
      && SRC_CODE[market.getSource()] != null;
  }

  function open(h, dir) {
    if (!canOpen(h) || (dir !== 'u' && dir !== 'd')) return false;
    const q = p();
    const price = Math.round(market.getPrice() * 100) / 100;
    q.f.push([h, dir, price, Date.now(), SRC_CODE[market.getSource()]]);
    if (q.f.length > HORIZONS.length) q.f.splice(0, q.f.length - HORIZONS.length);
    q.fh[h][0]++;
    tracker.rollDay();
    tracker.markActiveDay();
    tracker.changed();
    hooks.onChange?.();
    return true;
  }

  function resolve(fc, exit, how) {
    const q = p();
    const idx = q.f.indexOf(fc);
    if (idx < 0) return;
    q.f.splice(idx, 1);
    tracker.rollDay();
    const h = fc[H];
    const hz = HORIZONS[h];
    const row = q.fh[h];
    let result;
    let xp = 0;
    if (exit == null || Math.abs(exit - fc[ENTRY]) / fc[ENTRY] < TIE_FRACTION) {
      result = 'void';
      row[4]++;
    } else if (fc[DIR] === 'u' ? exit > fc[ENTRY] : exit < fc[ENTRY]) {
      result = 'win';
      row[1]++;
      row[2]++;
      row[3] = Math.max(row[3], row[2]);
      xp = tracker.addXp(hz.xp, hz.bucket);
      if (q.fd[0] !== q.day) q.fd = [q.day, 0];
      q.fd[1] |= 1 << h;
    } else {
      result = 'loss';
      row[2] = 0;
    }
    tracker.changed();
    hooks.onResolved?.({ h, dir: fc[DIR], entry: fc[ENTRY], exit, result, xp, how });
    hooks.onChange?.();
  }

  async function restResolve(fc) {
    const key = fc[AT];
    const now = Date.now();
    if (now - (lastRestTry.get(key) || 0) < REST_RETRY_MS) return;
    lastRestTry.set(key, now);
    const expiry = fc[AT] + HORIZONS[fc[H]].ms;
    const r = await klineCloseAt(expiry, fetchImpl);
    if (r.status === 'ok') {
      resolve(fc, r.price, `rest:${r.via}`);
    } else if (r.status === 'error') {
      if (!firstRestFail.has(key)) firstRestFail.set(key, now);
      if (now - fc[AT] > VOID_AFTER_MS + HORIZONS[fc[H]].ms) resolve(fc, null, 'expired');
    }
    // 'notyet': the exchange hasn't closed that minute (or the local clock runs ahead) → wait
  }

  async function tick() {
    if (!enabled || !store.isLeader || busy || !active().length) return;
    busy = true;
    try {
      const mono = monoNow();
      for (const fc of [...active()]) {
        const expiry = fc[AT] + HORIZONS[fc[H]].ms;
        if (expiry > sessionWall) {
          // expires during this session: wait on the monotonic clock
          if (mono < expiry) continue;
          const px = tracker.live ? livePriceFor(fc[SRC]) : null;
          if (px > 0 && mono - expiry <= LIVE_GRACE_MS) resolve(fc, px, 'live');
          else if (mono - expiry > LIVE_GRACE_MS) await restResolve(fc);
        } else {
          await restResolve(fc); // expired while the app was closed
        }
      }
    } finally {
      busy = false;
    }
  }

  const timer = setInterval(tick, TICK_MS);
  setTimeout(tick, 1500); // offline resolution shortly after launch

  // UI snapshot of active forecasts (allocates; called ≤ 5 Hz by the UI).
  function list() {
    const mono = monoNow();
    return active().map((fc) => {
      const hz = HORIZONS[fc[H]];
      const expiry = fc[AT] + hz.ms;
      const px = livePriceFor(fc[SRC]);
      const winning = px > 0 && Math.abs(px - fc[ENTRY]) / fc[ENTRY] >= TIE_FRACTION
        ? (fc[DIR] === 'u' ? px > fc[ENTRY] : px < fc[ENTRY]) : null;
      return {
        h: fc[H], id: hz.id, dir: fc[DIR], entry: fc[ENTRY], src: fc[SRC],
        remainingMs: Math.max(0, expiry - (expiry > sessionWall ? mono : Date.now())),
        pending: expiry <= mono, winning,
      };
    });
  }

  return {
    open,
    canOpen,
    list,
    tick,
    isActive: (h) => active().some((f) => f[H] === h),
    stop() { clearInterval(timer); },
  };
}
