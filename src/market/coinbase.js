// Coinbase Exchange BTC-USD: `matches` for prints, `ticker` as a price fallback.
// NOTE: in `match` messages `side` is the MAKER's side; the taker (aggressor) is the opposite.
import { createSocket } from './ws.js?v=1c0f08fd';
import { createPrintMerger, stripKey } from './prints.js?v=1c0f08fd';

const URLS = ['wss://ws-feed.exchange.coinbase.com'];
const PRODUCT = 'BTC-USD';

export function connectCoinbase({ onPrice, onTrade, onState }) {
  let change24h = null;
  const merger = createPrintMerger((p) => onTrade(stripKey(p)));

  return createSocket({
    urls: URLS,
    staleMs: 30000,
    onState,
    onOpen(send) {
      send({ type: 'subscribe', product_ids: [PRODUCT], channels: ['matches', 'ticker'] });
    },
    onMessage(d) {
      if (d.product_id !== PRODUCT) return;
      if (d.type === 'match') {
        const price = +d.price;
        const side = d.side === 'buy' ? 'sell' : 'buy'; // maker side → taker side
        merger.add({
          key: d.taker_order_id || `${d.time}:${side}`,
          exchange: 'coinbase',
          side,
          price,
          qty: +d.size,
          ts: Date.parse(d.time) || Date.now(),
        });
        onPrice({ price, change24h });
      } else if (d.type === 'ticker') {
        const price = +d.price;
        const open = +d.open_24h;
        if (open > 0) change24h = ((price - open) / open) * 100;
        onPrice({ price, change24h });
      }
    },
  });
}
