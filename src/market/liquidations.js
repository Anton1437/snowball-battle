// Binance USD-M futures liquidation stream (best effort — often geo-blocked; failures are silent).
// Order side SELL = a long got liquidated (forced sell → hurts GREEN);
// BUY = a short got liquidated (forced buy → hurts RED).
import { createSocket } from './ws.js?v=1c0f08fd';

const URLS = ['wss://fstream.binance.com/ws/btcusdt@forceOrder'];

export function connectLiquidations({ onLiquidation, onState }) {
  return createSocket({
    urls: URLS,
    minBackoffMs: 5000,
    maxBackoffMs: 120000,
    staleMs: 0, // the stream can be legitimately silent for a long time
    onState,
    onMessage(d) {
      const o = d?.o;
      if (d?.e !== 'forceOrder' || !o) return;
      const qty = +(o.z || o.q);
      const price = +(o.ap || o.p);
      if (!(qty > 0 && price > 0)) return;
      onLiquidation({
        exchange: 'binance',
        side: o.S === 'SELL' ? 'sell' : 'buy',   // direction of the forced order
        liquidated: o.S === 'SELL' ? 'long' : 'short',
        price,
        qty,
        usd: price * qty,
        ts: o.T || d.E || Date.now(),
      });
    },
  });
}
