// Bybit v5 public streams (verified against bybit-exchange.github.io/docs/v5/websocket/public/*):
//   spot   wss://stream.bybit.com/v5/public/spot    publicTrade / orderbook.50 / tickers  (BTCUSDT)
//   linear wss://stream.bybit.com/v5/public/linear  allLiquidation.BTCUSDT
// Heartbeat: send {"op":"ping"} every 20 s (server drops idle connections).
import { createSocket } from './ws.js?v=4055052d';
import { createPrintMerger, stripKey } from './prints.js?v=4055052d';

const SPOT_URL = 'wss://stream.bybit.com/v5/public/spot';
const LINEAR_URL = 'wss://stream.bybit.com/v5/public/linear';
const SYMBOL = 'BTCUSDT';
const PING_MS = 20000;
const WALL_BAND = 0.005;   // ±0.5% of mid
const WALL_EMIT_MS = 500;

function withPing(sock) {
  const timer = setInterval(() => sock.send({ op: 'ping' }), PING_MS);
  return {
    get connected() { return sock.connected; },
    close() {
      clearInterval(timer);
      sock.close();
    },
  };
}

// Local L2 book: price → qty. Snapshot (or u = 1, a service restart) replaces it; deltas
// insert/update levels and a size of "0" deletes the level. O(changes) per message.
function createBook() {
  const bids = new Map();
  const asks = new Map();
  const apply = (side, levels) => {
    for (let i = 0; i < levels.length; i++) {
      const p = +levels[i][0];
      const q = +levels[i][1];
      if (q === 0) side.delete(p);
      else side.set(p, q);
    }
  };
  return {
    update(type, data) {
      if (type === 'snapshot' || data.u === 1) {
        bids.clear();
        asks.clear();
      }
      if (data.b) apply(bids, data.b);
      if (data.a) apply(asks, data.a);
    },
    // Resting USD within ±band of mid (≤ 50 levels per side, run at ~2 Hz).
    walls(band) {
      let bestBid = 0;
      let bestAsk = Infinity;
      for (const p of bids.keys()) if (p > bestBid) bestBid = p;
      for (const p of asks.keys()) if (p < bestAsk) bestAsk = p;
      if (!bestBid || bestAsk === Infinity || bestBid >= bestAsk) return null;
      const mid = (bestBid + bestAsk) / 2;
      let bidUsd = 0;
      let askUsd = 0;
      for (const [p, q] of bids) if (p >= mid * (1 - band)) bidUsd += p * q;
      for (const [p, q] of asks) if (p <= mid * (1 + band)) askUsd += p * q;
      return { bidUsd, askUsd, bestBid, bestAsk };
    },
  };
}

export function connectBybit({ onPrice, onTrade, onWalls, onState }) {
  let change24h = null;
  let lastWallEmit = 0;
  const book = createBook();
  const merger = createPrintMerger((p) => onTrade(stripKey(p)));

  const sock = createSocket({
    urls: [SPOT_URL],
    staleMs: 15000,
    onState,
    onOpen(send) {
      send({ op: 'subscribe', args: [`publicTrade.${SYMBOL}`, `orderbook.50.${SYMBOL}`, `tickers.${SYMBOL}`] });
    },
    onMessage(msg) {
      const topic = msg.topic;
      if (!topic) return; // pong / subscribe acks
      const d = msg.data;
      if (topic.startsWith('publicTrade.')) {
        let last = 0;
        for (let i = 0; i < d.length; i++) {
          const f = d[i];
          const side = f.S === 'Buy' ? 'buy' : 'sell'; // S = taker side
          const price = +f.p;
          merger.add({ key: `${f.T}:${side}`, exchange: 'bybit', side, price, qty: +f.v, ts: f.T });
          last = price;
        }
        if (last) onPrice({ price: last, change24h });
      } else if (topic.startsWith('orderbook.')) {
        book.update(msg.type, d);
        const now = Date.now();
        if (now - lastWallEmit >= WALL_EMIT_MS) {
          const w = book.walls(WALL_BAND);
          if (w) {
            lastWallEmit = now;
            onWalls(w);
          }
        }
      } else if (topic.startsWith('tickers.')) {
        // spot tickers are always full snapshots; price24hPcnt is a fraction (0.0196 = +1.96%)
        if (d.price24hPcnt != null) change24h = +d.price24hPcnt * 100;
        if (d.lastPrice) onPrice({ price: +d.lastPrice, change24h });
      }
    },
  });
  return withPing(sock);
}

// Bybit liquidations. Per the docs, S is the POSITION side: "When you receive a Buy update,
// this means that a long position has been liquidated". (Binance forceOrder S is the order side.)
// Our convention: long liquidated → forced sell → side 'sell' (hurts green).
export function connectBybitLiquidations({ onLiquidation, onState }) {
  const sock = createSocket({
    urls: [LINEAR_URL],
    minBackoffMs: 5000,
    maxBackoffMs: 120000,
    staleMs: 0, // can be silent for a long time; the ping keeps it open
    onState,
    onOpen(send) {
      send({ op: 'subscribe', args: [`allLiquidation.${SYMBOL}`] });
    },
    onMessage(msg) {
      if (!msg.topic?.startsWith('allLiquidation.') || !Array.isArray(msg.data)) return;
      for (const x of msg.data) {
        const qty = +x.v;
        const price = +x.p; // bankruptcy price
        if (!(qty > 0 && price > 0)) continue;
        const longLiquidated = x.S === 'Buy';
        onLiquidation({
          exchange: 'bybit',
          side: longLiquidated ? 'sell' : 'buy',
          liquidated: longLiquidated ? 'long' : 'short',
          price,
          qty,
          usd: price * qty,
          ts: x.T || msg.ts || Date.now(),
        });
      }
    },
  });
  return withPing(sock);
}
