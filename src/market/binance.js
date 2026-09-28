// Binance spot BTCUSDT: aggTrade + 24h ticker + depth20 (for buy/sell walls).
import { createSocket } from './ws.js?v=1c0f08fd';
import { createPrintMerger, stripKey } from './prints.js?v=1c0f08fd';

const STREAMS = ['btcusdt@aggTrade', 'btcusdt@ticker', 'btcusdt@depth20@100ms'].join('/');
const URLS = [
  `wss://stream.binance.com:9443/stream?streams=${STREAMS}`,
  `wss://data-stream.binance.vision/stream?streams=${STREAMS}`,
];
const WALL_BAND = 0.005;   // count book liquidity within ±0.5% of mid
const WALL_EMIT_MS = 500;

export function connectBinance({ onPrice, onTrade, onWalls, onState }) {
  let change24h = null;
  let lastWallEmit = 0;

  const merger = createPrintMerger((p) => onTrade(stripKey(p)));

  function handleAggTrade(d) {
    const price = +d.p;
    const qty = +d.q;
    // m = buyer is the maker → the aggressor (taker) sold.
    const side = d.m ? 'sell' : 'buy';
    merger.add({ key: `${d.T}:${side}`, exchange: 'binance', side, price, qty, ts: d.T });
    onPrice({ price, change24h });
  }

  function handleDepth(d) {
    const now = Date.now();
    if (now - lastWallEmit < WALL_EMIT_MS) return;
    const bids = d.bids || d.b;
    const asks = d.asks || d.a;
    if (!bids?.length || !asks?.length) return;
    lastWallEmit = now;
    const mid = (+bids[0][0] + +asks[0][0]) / 2;
    const sum = (levels, inBand) => levels.reduce((acc, [p, q]) => (inBand(+p) ? acc + +p * +q : acc), 0);
    onWalls({
      bidUsd: sum(bids, (p) => p >= mid * (1 - WALL_BAND)),
      askUsd: sum(asks, (p) => p <= mid * (1 + WALL_BAND)),
    });
  }

  return createSocket({
    urls: URLS,
    staleMs: 15000,
    onState,
    onMessage(msg) {
      const d = msg.data;
      if (!d) return;
      if (d.e === 'aggTrade') handleAggTrade(d);
      else if (d.e === '24hrTicker') {
        change24h = +d.P;
        onPrice({ price: +d.c, change24h });
      } else if (msg.stream?.includes('@depth')) handleDepth(d);
    },
  });
}
