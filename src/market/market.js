// Market orchestrator: multi-exchange aggregation (default) or a single chosen venue, with a
// DEMO sim fallback; classifies big prints, throttles giant events, schedules synthetic whales.
//
// Venues: Binance spot (BTCUSDT), Bybit spot (BTCUSDT), Coinbase (BTC-USD) + liquidations from
// Binance USD-M futures and Bybit linear.
//
// Source selection (market.setSource): 'AGG' | 'BINANCE' | 'BYBIT' | 'COINBASE'.
//   AGG: price = mean of venues with a tick in the last 5 s; trades/flow from all venues;
//        walls = Binance depth20 + Bybit ob50 within ±0.5%.
//   Single venue: price/trades/walls from that venue only. If it is down the effective source
//        falls back to AGG and is promoted back once the venue has been stable for 2 s.
//   DEMO: only when no venue has produced a price for 6 s.
// Whenever the set of venues behind the price changes automatically (a venue drops, joins late,
// fallback/promotion), a correction offset keeps the price continuous and decays to 0 (~30 s).
// A user source change (reason 'user') or leaving DEMO resets the basis — main restarts the round.
//
// Events (market.on(type, fn)):
//   price    { price, change24h, source }                           ≤10 Hz
//   trade    { exchange:'binance'|'bybit'|'coinbase'|'demo', side:'buy'|'sell', price, qty, usd, ts }
//   bigprint { exchange|null, side, usd, kind:'trade'|'liquidation'|'whale', tier:'big'|'giant',
//              synthetic, price, ts, liquidated?:'long'|'short', merged?:n }
//   walls    { bidUsd, askUsd } | null                               ~2 Hz
//   flow     { pressure:[-1,1], buyUsd, sellUsd }                     4 Hz
//   status   { source:'AGG'|'BINANCE'|'BYBIT'|'COINBASE'|'DEMO'|null, selected, liveCount,
//              venues:{ binance|bybit|coinbase: { connected, alive, price } },
//              liquidations:{ binance, bybit }, connected, reason:'user'|undefined }
//            source null = still connecting (until the first venue answers, ≤6 s).
//   liquidation { exchange, side, liquidated, price, qty, usd, ts }   every liquidation, any size
//
// `side` always means which team the event helps: 'buy' → GREEN, 'sell' → RED.
import { createEmitter } from './emitter.js?v=1c0f08fd';
import { createFlow } from './flow.js?v=1c0f08fd';
import { createSim } from './sim.js?v=1c0f08fd';
import { connectBinance } from './binance.js?v=1c0f08fd';
import { connectBybit, connectBybitLiquidations } from './bybit.js?v=1c0f08fd';
import { connectCoinbase } from './coinbase.js?v=1c0f08fd';
import { connectLiquidations } from './liquidations.js?v=1c0f08fd';

export const TIERS = {
  bigTrade: 250_000,
  giantTrade: 1_000_000,
  bigLiquidation: 25_000,
  giantLiquidation: 100_000,
};
export const VENUES = ['binance', 'bybit', 'coinbase'];
export const SOURCES = ['AGG', 'BINANCE', 'BYBIT', 'COINBASE'];

const FRESH_MS = 5000;          // a venue counts in the aggregate if it ticked within this
const DEMO_AFTER_MS = 6000;     // DEMO only after this long with no venue ticking
const RECOVER_MS = 2000;        // a venue must be fresh this long before it is (re)promoted
const OFFSET_TAU_MS = 8000;     // basis-change correction decays e^(-t/τ): ~2% left after 30 s
const WALLS_FRESH_MS = 5000;
const PRICE_EMIT_MS = 100;
const FLOW_EMIT_MS = 250;
const EVAL_MS = 500;
const LANE_GAPS = { giant: 8000, big: 600 };
const KIND_PRIORITY = { whale: 0, trade: 1, liquidation: 2 };
const DEFAULT_START_PRICE = 85000;
const BIT = { binance: 1, bybit: 2, coinbase: 4 };

const rand = (a, b) => a + Math.random() * (b - a);
const venueOf = (src) => (src === 'BINANCE' || src === 'BYBIT' || src === 'COINBASE' ? src.toLowerCase() : null);

export function createMarket({
  demo = false,
  whaleIntervalSec = [40, 120],
  source: initialSelection = 'AGG',
  // for testing fallbacks: which sockets to open, and optional per-venue open delays (ms)
  enabledFeeds = { binance: true, bybit: true, coinbase: true, liquidations: true },
  delays = {},
} = {}) {
  const em = createEmitter();
  const flow = createFlow();
  const venues = {};
  for (const name of VENUES) {
    venues[name] = { name, connected: false, price: null, change24h: null, at: 0, freshSince: 0, walls: null, wallsAt: 0 };
  }
  const liq = { binance: false, bybit: false };
  const conns = [];
  const connByVenue = {};
  const timers = [];
  const lanes = {
    giant: { gap: LANE_GAPS.giant, last: 0, queue: [], timer: 0 },
    big: { gap: LANE_GAPS.big, last: 0, queue: [], timer: 0 },
  };

  let selected = SOURCES.includes(initialSelection) ? initialSelection : 'AGG';
  let source = null;
  let startedAt = 0;
  let sim = null;
  let price = null;
  let change24h = null;
  let walls = null;
  let lastKnownPrice = null;
  let priceEmitTimer = 0;
  let lastPriceEmit = 0;
  let whaleTimer = 0;
  // price basis continuity
  let basisMask = 0;
  let basisReset = true;
  let offset = 0;
  let offsetAt = 0;
  let aliveMask = 0;

  const fresh = (v, now, ms = FRESH_MS) => v.at > 0 && now - v.at < ms;
  const stable = (v, now) => fresh(v, now) && now - v.freshSince >= RECOVER_MS;
  const isLive = () => source !== null && source !== 'DEMO';

  // ---------- price ----------
  function setPrice(p, ch) {
    if (!(p > 0)) return;
    price = p;
    lastKnownPrice = p;
    if (ch != null && Number.isFinite(ch)) change24h = ch;
    const now = Date.now();
    const wait = PRICE_EMIT_MS - (now - lastPriceEmit);
    if (wait <= 0) emitPrice();
    else if (!priceEmitTimer) priceEmitTimer = setTimeout(emitPrice, wait);
  }

  function emitPrice() {
    clearTimeout(priceEmitTimer);
    priceEmitTimer = 0;
    lastPriceEmit = Date.now();
    em.emit('price', { price, change24h, source });
  }

  // Venues whose price feeds the current source (bitmask, no allocation).
  function contributingMask(now) {
    const single = venueOf(source);
    if (single) return fresh(venues[single], now) ? BIT[single] : 0;
    let mask = 0;
    for (const name of VENUES) if (fresh(venues[name], now)) mask |= BIT[name];
    return mask;
  }

  function change24hFor(now) {
    const single = venueOf(source);
    if (single && venues[single].change24h != null) return venues[single].change24h;
    for (const name of VENUES) {
      const v = venues[name];
      if (v.change24h != null && fresh(v, now)) return v.change24h;
    }
    return null;
  }

  // Aggregate / single-venue price with a decaying continuity offset.
  function updateLivePrice(now) {
    const mask = contributingMask(now);
    if (!mask) return;
    let sum = 0;
    let n = 0;
    for (const name of VENUES) {
      if (mask & BIT[name]) {
        sum += venues[name].price;
        n++;
      }
    }
    const raw = sum / n;
    if (offset !== 0) {
      offset *= Math.exp(-(now - offsetAt) / OFFSET_TAU_MS);
      if (Math.abs(offset) < 0.005) offset = 0;
    }
    offsetAt = now;
    if (mask !== basisMask) {
      // e.g. $30 USDT/USD basis between venues: absorb the step, then let it bleed out
      offset = basisReset || price == null ? 0 : price - raw;
      basisMask = mask;
      basisReset = false;
    }
    setPrice(raw + offset, change24hFor(now));
  }

  function onVenuePrice(name, { price: p, change24h: ch }) {
    const v = venues[name];
    const now = Date.now();
    if (!fresh(v, now)) v.freshSince = now;
    v.at = now;
    v.price = p;
    if (ch != null) v.change24h = ch;
    if (source === null || source === 'DEMO' || (!(aliveMask & BIT[name]))) evaluateSource(); // joins / first data
    else if (isLive()) updateLivePrice(now);
  }

  // ---------- source selection ----------
  function pickSource(now) {
    if (demo) return 'DEMO';
    let anyTicking = false;
    let anyStable = false;
    for (const name of VENUES) {
      if (fresh(venues[name], now, DEMO_AFTER_MS)) anyTicking = true;
      if (stable(venues[name], now)) anyStable = true;
    }
    if (!anyTicking) return source === null && now - startedAt < DEMO_AFTER_MS ? null : 'DEMO';
    if (source === 'DEMO' && !anyStable) return 'DEMO'; // leave DEMO only on a stable venue
    const single = venueOf(selected);
    if (single) {
      const v = venues[single];
      if (source === selected ? fresh(v, now) : stable(v, now)) return selected;
    }
    return 'AGG'; // whichever venues answer first (no waiting for a preferred one)
  }

  function evaluateSource(reason) {
    const now = Date.now();
    let mask = 0;
    for (const name of VENUES) if (fresh(venues[name], now)) mask |= BIT[name];
    const next = pickSource(now);
    const changed = next !== source;
    if (changed) {
      const wasLive = isLive();
      source = next;
      if (source === 'DEMO') startSim();
      else stopSim();
      if (!wasLive) basisReset = true; // leaving DEMO / first price: no continuity needed
    }
    if (isLive()) {
      updateLivePrice(now);
      updateWalls(now);
    }
    if (changed || mask !== aliveMask || reason) {
      aliveMask = mask;
      emitStatus(reason);
    }
  }

  function venueSnapshot() {
    const now = Date.now();
    const out = {};
    for (const name of VENUES) {
      const v = venues[name];
      out[name] = { connected: v.connected, alive: fresh(v, now), price: v.price, walls: v.walls };
    }
    return out;
  }

  function liveCount() {
    const now = Date.now();
    let n = 0;
    for (const name of VENUES) if (fresh(venues[name], now)) n++;
    return n;
  }

  function emitStatus(reason) {
    em.emit('status', {
      source,
      selected,
      liveCount: liveCount(),
      venues: venueSnapshot(),
      liquidations: { ...liq },
      connected: isLive(),
      reason,
    });
  }

  function startSim() {
    if (sim) return;
    flow.reset();
    walls = null;
    sim = createSim({
      startPrice: lastKnownPrice || DEFAULT_START_PRICE,
      onPrice: ({ price: p, change24h: ch }) => { if (source === 'DEMO') setPrice(p, ch); },
      onTrade: (t) => { if (source === 'DEMO') onTrade(t, true); },
      onWalls: (w) => { if (source === 'DEMO') setWalls(w); },
    });
  }

  function stopSim() {
    if (!sim) return;
    sim.close();
    sim = null;
    flow.reset();
  }

  // Walls = sum of the books behind the current source (Coinbase has no book here).
  function updateWalls(now) {
    const single = venueOf(source);
    let bid = 0;
    let ask = 0;
    let n = 0;
    for (const name of VENUES) {
      const v = venues[name];
      if (single && name !== single) continue;
      if (!v.walls || now - v.wallsAt > WALLS_FRESH_MS) continue;
      bid += v.walls.bidUsd;
      ask += v.walls.askUsd;
      n++;
    }
    if (n) setWalls({ bidUsd: bid, askUsd: ask });
    else if (walls !== null) setWalls(null);
  }

  function onVenueWalls(name, w) {
    const v = venues[name];
    v.walls = w;
    v.wallsAt = Date.now();
  }

  // ---------- trades / walls ----------
  function onTrade(t, synthetic = false) {
    flow.add(t.side, t.usd, Date.now());
    em.emit('trade', t);
    const tier = t.usd >= TIERS.giantTrade ? 'giant' : t.usd >= TIERS.bigTrade ? 'big' : null;
    if (tier) {
      dispatchBigprint({
        exchange: synthetic ? null : t.exchange,
        side: t.side,
        usd: t.usd,
        kind: 'trade',
        tier,
        synthetic,
        price: t.price,
        ts: t.ts,
      });
    }
  }

  // Live prints count only if their venue is behind the current source.
  function onLiveTrade(t) {
    if (!isLive()) return; // never mix live prints into the sim
    const single = venueOf(source);
    if (single && t.exchange !== single) return;
    onTrade(t);
  }

  function setWalls(w) {
    walls = w;
    em.emit('walls', w);
  }

  function onLiquidation(l) {
    em.emit('liquidation', l);
    const tier = l.usd >= TIERS.giantLiquidation ? 'giant' : l.usd >= TIERS.bigLiquidation ? 'big' : null;
    if (!tier) return;
    dispatchBigprint({
      exchange: l.exchange,
      side: l.side,
      usd: l.usd,
      kind: 'liquidation',
      tier,
      synthetic: false,
      price: l.price,
      ts: l.ts,
      liquidated: l.liquidated,
    });
  }

  // ---------- bigprint throttling ----------
  // Each tier is a lane with a minimum gap; while a lane is busy, events queue and
  // same-side events merge (usd summed, strongest kind wins).
  function dispatchBigprint(bp) {
    const lane = lanes[bp.tier];
    const now = Date.now();
    if (!lane.queue.length && now - lane.last >= lane.gap) {
      fire(lane, bp);
      return;
    }
    const same = lane.queue.find((q) => q.side === bp.side);
    if (same) {
      same.usd += bp.usd;
      same.merged = (same.merged || 1) + 1;
      if (KIND_PRIORITY[bp.kind] > KIND_PRIORITY[same.kind]) {
        Object.assign(same, { kind: bp.kind, exchange: bp.exchange, synthetic: bp.synthetic, liquidated: bp.liquidated });
      }
    } else {
      lane.queue.push({ ...bp });
    }
    scheduleDrain(lane);
  }

  function scheduleDrain(lane) {
    if (lane.timer) return;
    const wait = Math.max(0, lane.last + lane.gap - Date.now());
    lane.timer = setTimeout(() => {
      lane.timer = 0;
      const next = lane.queue.shift();
      if (next) fire(lane, next);
      if (lane.queue.length) scheduleDrain(lane);
    }, wait);
  }

  function fire(lane, bp) {
    lane.last = Date.now();
    em.emit('bigprint', bp);
    scheduleWhale();
  }

  // ---------- synthetic whales ----------
  function scheduleWhale(delayMs = rand(whaleIntervalSec[0], whaleIntervalSec[1]) * 1000) {
    clearTimeout(whaleTimer);
    whaleTimer = setTimeout(fireWhale, delayMs);
  }

  function fireWhale() {
    const giant = lanes.giant;
    if (price == null || giant.queue.length || Date.now() - giant.last < giant.gap) {
      scheduleWhale(5000);
      return;
    }
    const { pressure } = flow.snapshot();
    const side = Math.random() < 0.5 + 0.35 * pressure ? 'buy' : 'sell';
    const usd = Math.round((1 + Math.random() ** 2 * 5) * 100) * 10_000; // $1M–$6M, skewed low
    dispatchBigprint({
      exchange: null, side, usd, kind: 'whale', tier: 'giant', synthetic: true, price, ts: Date.now(),
    });
  }

  // ---------- lifecycle ----------
  function openAfter(name, open) {
    const go = () => {
      const c = open();
      conns.push(c);
      connByVenue[name] = c;
    };
    const delay = delays[name] || 0;
    if (delay) timers.push(setTimeout(go, delay)); // test hook: simulate a slow venue
    else go();
  }

  function start() {
    startedAt = Date.now();
    if (!demo) {
      const venueState = (name) => (connected) => {
        venues[name].connected = connected;
        emitStatus();
      };
      const liqState = (name) => (connected) => {
        liq[name] = connected;
        emitStatus();
      };
      if (enabledFeeds.binance) openAfter('binance', () => connectBinance({
        onPrice: (p) => onVenuePrice('binance', p),
        onTrade: onLiveTrade,
        onWalls: (w) => onVenueWalls('binance', w),
        onState: venueState('binance'),
      }));
      if (enabledFeeds.bybit) openAfter('bybit', () => connectBybit({
        onPrice: (p) => onVenuePrice('bybit', p),
        onTrade: onLiveTrade,
        onWalls: (w) => onVenueWalls('bybit', w),
        onState: venueState('bybit'),
      }));
      if (enabledFeeds.coinbase) openAfter('coinbase', () => connectCoinbase({
        onPrice: (p) => onVenuePrice('coinbase', p),
        onTrade: onLiveTrade,
        onState: venueState('coinbase'),
      }));
      if (enabledFeeds.liquidations) {
        conns.push(connectLiquidations({ onLiquidation, onState: liqState('binance') }));
        conns.push(connectBybitLiquidations({ onLiquidation, onState: liqState('bybit') }));
      }
    }
    evaluateSource();
    timers.push(setInterval(() => evaluateSource(), EVAL_MS));
    timers.push(setInterval(() => em.emit('flow', flow.snapshot()), FLOW_EMIT_MS));
    scheduleWhale();
  }

  function stop() {
    conns.splice(0).forEach((c) => c.close());
    timers.splice(0).forEach((t) => { clearInterval(t); clearTimeout(t); });
    clearTimeout(whaleTimer);
    clearTimeout(priceEmitTimer);
    Object.values(lanes).forEach((l) => { clearTimeout(l.timer); l.timer = 0; l.queue.length = 0; });
    stopSim();
  }

  // User source choice: resets the price basis (the round restarts on reason 'user').
  function setSource(sel) {
    if (!SOURCES.includes(sel)) return;
    selected = sel;
    basisReset = true;
    basisMask = -1;
    flow.reset();
    evaluateSource('user');
  }

  return {
    on: em.on,
    off: em.off,
    start,
    stop,
    getPrice: () => price,
    getChange24h: () => change24h,
    getSource: () => source,
    getSelected: () => selected,
    setSource,
    getVenues: venueSnapshot,
    getLiveCount: liveCount,
    getWalls: () => walls,
    getFlow: () => flow.snapshot(),
    getFeeds: () => ({
      binance: venues.binance.connected, bybit: venues.bybit.connected, coinbase: venues.coinbase.connected,
      liqBinance: liq.binance, liqBybit: liq.bybit,
    }),
    getPriceOffset: () => offset,
    // Test hook: permanently close one venue's socket (simulates it going dark mid-run).
    debugCloseVenue(name) {
      connByVenue[name]?.close();
    },
    getSimRegime: () => sim?.regime ?? null,
    // Debug helper for renderer work: market.debugBigprint('buy', 'giant')
    debugBigprint(side = 'buy', tier = 'giant', kind = 'whale') {
      dispatchBigprint({
        exchange: null, side, usd: tier === 'giant' ? 2_000_000 : 400_000, kind, tier,
        synthetic: true, price, ts: Date.now(),
      });
    },
  };
}
