// Merges consecutive fills belonging to one taker order into a single "print".
// A market order sweeping several levels arrives as several fills sharing a key
// (Binance: same trade time + side; Coinbase: same taker_order_id).

const FLUSH_MS = 80;

export function createPrintMerger(onPrint) {
  let pending = null;
  let timer = 0;

  function flush() {
    clearTimeout(timer);
    if (!pending) return;
    const p = pending;
    pending = null;
    p.price = p.usd / p.qty; // VWAP of the sweep
    onPrint(p);
  }

  return {
    // fill: { key, exchange, side, price, qty, ts }
    add(fill) {
      if (!(fill.qty > 0) || !(fill.price > 0)) return;
      const usd = fill.price * fill.qty;
      if (pending && pending.key === fill.key) {
        pending.qty += fill.qty;
        pending.usd += usd;
      } else {
        flush();
        pending = { key: fill.key, exchange: fill.exchange, side: fill.side, price: fill.price, qty: fill.qty, usd, ts: fill.ts };
      }
      clearTimeout(timer);
      timer = setTimeout(flush, FLUSH_MS);
    },
    flush,
  };
}

export function stripKey({ key, ...trade }) {
  return trade;
}
