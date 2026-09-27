// Market orchestrator: picks the live price source (Binance → Coinbase → DEMO sim),
// classifies big prints, throttles giant events and schedules synthetic whales.
//
// Events (market.on(type, fn)):
//   price    { price, change24h, source }                           ≤10 Hz
//   trade    { exchange, side:'buy'|'sell', price, qty, usd, ts }    exchange: 'binance'|'coinbase'|'demo'
//   bigprint { exchange|null, side, usd, kind:'trade'|'liquidation'|'whale', tier:'big'|'giant',
//              synthetic, price, ts, liquidated?:'long'|'short', merged?:n }
//   walls    { bidUsd, askUsd }                                      ~2 Hz (absent on COINBASE source)
//   flow     { pressure:[-1,1], buyUsd, sellUsd }                     4 Hz
//   status   { source:'BINANCE'|'COINBASE'|'DEMO'|null, connected, feeds:{binance,coinbase,liquidations} }
//            source null = still connecting (first ≤6 s).
//   liquidation { side, liquidated, price, qty, usd, ts }             every liquidation, any size
//
// `side` always means which team the event helps: 'buy' → GREEN, 'sell' → RED.
import { createEmitter } from './emitter.js';
import { createFlow } from './flow.js';
import { createSim } from './sim.js';
import { connectBinance } from './binance.js';
import { connectCoinbase } from './coinbase.js';
import { connectLiquidations } from './liquidations.js';

export const TIERS = {
  bigTrade: 250_000,
  giantTrade: 1_000_000,
  bigLiquidation: 25_000,
  giantLiquidation: 100_000,
};

const LIVE_TIMEOUT_MS = 6000;   // feed considered dead after this long without a price
const RECOVER_MS = 2000;        // a feed must be fresh this long before we switch back to it
const INITIAL_PREFER_MS = 2500; // on startup, wait this long for Binance before using Coinbase
const PRICE_EMIT_MS = 100;
const FLOW_EMIT_MS = 250;
const LANE_GAPS = { giant: 8000, big: 600 };
const KIND_PRIORITY = { whale: 0, trade: 1, liquidation: 2 };
const DEFAULT_START_PRICE = 85000;

const rand = (a, b) => a + Math.random() * (b - a);

export function createMarket({
  demo = false,
  whaleIntervalSec = [40, 120],
  enabledFeeds = { binance: true, coinbase: true, liquidations: true }, // for testing fallbacks
} = {}) {
  const em = createEmitter();
  const flow = createFlow();
  const feeds = {
    binance: { connected: false, price: null, change24h: null, at: 0, freshSince: 0 },
    coinbase: { connected: false, price: null, change24h: null, at: 0, freshSince: 0 },
    liquidations: { connected: false },
  };
  const conns = [];
  const timers = [];
  const lanes = {
    giant: { gap: LANE_GAPS.giant, last: 0, queue: [], timer: 0 },
    big: { gap: LANE_GAPS.big, last: 0, queue: [], timer: 0 },
  };

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

  function onLivePrice(name, { price: p, change24h: ch }) {
    const f = feeds[name];
    const now = Date.now();
    if (!f.at || now - f.at > LIVE_TIMEOUT_MS) f.freshSince = now;
    f.at = now;
    f.price = p;
    if (ch != null) f.change24h = ch;
    if (source === feedSource(name)) setPrice(p, f.change24h);
    else if (source === null || source === 'DEMO') evaluateSource(); // react fast on first data / recovery
  }

  const feedSource = (name) => name.toUpperCase();

  // ---------- source selection ----------
  function pickSource(now) {
    if (demo) return 'DEMO';
    const b = feeds.binance;
    const c = feeds.coinbase;
    const alive = (f) => f.at > 0 && now - f.at < LIVE_TIMEOUT_MS;
    const stable = (f) => alive(f) && now - f.freshSince >= RECOVER_MS;
    if (source === null) {
      // Initial connect: take Binance as soon as it's up; give it a head start before settling for Coinbase.
      if (alive(b)) return 'BINANCE';
      if (alive(c) && now - startedAt >= INITIAL_PREFER_MS) return 'COINBASE';
      return now - startedAt < LIVE_TIMEOUT_MS ? null : 'DEMO';
    }
    // Prefer Binance; switching to a feed other than the current one needs RECOVER_MS of stability.
    if (source === 'BINANCE' ? alive(b) : stable(b)) return 'BINANCE';
    if (source === 'COINBASE' ? alive(c) : stable(c)) return 'COINBASE';
    if (source !== 'DEMO') {
      if (alive(c)) return 'COINBASE';
      if (alive(b)) return 'BINANCE';
    }
    return 'DEMO';
  }

  function evaluateSource() {
    const next = pickSource(Date.now());
    if (next === source) return;
    source = next;
    if (source !== 'BINANCE') walls = null; // depth only comes from Binance (or the sim)
    if (source === 'DEMO') startSim();
    else stopSim();
    if (source === 'BINANCE' || source === 'COINBASE') {
      const f = feeds[source.toLowerCase()];
      setPrice(f.price, f.change24h);
    }
    emitStatus();
  }

  const feedFlags = () => ({
    binance: feeds.binance.connected,
    coinbase: feeds.coinbase.connected,
    liquidations: feeds.liquidations.connected,
  });

  function emitStatus() {
    em.emit('status', { source, connected: source === 'BINANCE' || source === 'COINBASE', feeds: feedFlags() });
  }

  function startSim() {
    if (sim) return;
    flow.reset();
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

  function onLiveTrade(t) {
    if (source !== 'DEMO') onTrade(t); // don't mix stray live prints into the sim
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
      exchange: 'binance',
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
  function start() {
    startedAt = Date.now();
    if (!demo) {
      const feedState = (name) => (connected) => {
        feeds[name].connected = connected;
        emitStatus();
      };
      if (enabledFeeds.binance) conns.push(connectBinance({
        onPrice: (p) => onLivePrice('binance', p),
        onTrade: onLiveTrade,
        onWalls: (w) => { if (source === 'BINANCE') setWalls(w); },
        onState: feedState('binance'),
      }));
      if (enabledFeeds.coinbase) conns.push(connectCoinbase({
        onPrice: (p) => onLivePrice('coinbase', p),
        onTrade: onLiveTrade,
        onState: feedState('coinbase'),
      }));
      if (enabledFeeds.liquidations) conns.push(connectLiquidations({
        onLiquidation,
        onState: feedState('liquidations'),
      }));
    }
    evaluateSource();
    emitStatus();
    timers.push(setInterval(evaluateSource, 500));
    timers.push(setInterval(() => em.emit('flow', flow.snapshot()), FLOW_EMIT_MS));
    scheduleWhale();
  }

  function stop() {
    conns.splice(0).forEach((c) => c.close());
    timers.splice(0).forEach(clearInterval);
    clearTimeout(whaleTimer);
    clearTimeout(priceEmitTimer);
    Object.values(lanes).forEach((l) => { clearTimeout(l.timer); l.timer = 0; l.queue.length = 0; });
    stopSim();
  }

  return {
    on: em.on,
    off: em.off,
    start,
    stop,
    getPrice: () => price,
    getChange24h: () => change24h,
    getSource: () => source,
    getWalls: () => walls,
    getFlow: () => flow.snapshot(),
    getFeeds: feedFlags,
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
