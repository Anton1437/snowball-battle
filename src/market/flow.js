// Rolling order-flow pressure: exponentially decayed buy vs sell taker notional.
// With tau = 7 s, a trade 20 s old keeps ~6% weight — effectively a ~20 s window.

export function createFlow({ tauSec = 7, floorUsd = 10_000 } = {}) {
  let buy = 0;
  let sell = 0;
  let last = Date.now();

  function decay(now) {
    const dt = Math.max(0, now - last) / 1000;
    if (dt > 0) {
      const k = Math.exp(-dt / tauSec);
      buy *= k;
      sell *= k;
      last = now;
    }
  }

  return {
    add(side, usd, now = Date.now()) {
      decay(now);
      if (side === 'buy') buy += usd;
      else sell += usd;
    },
    // pressure in [-1, 1]: +1 = all buying, -1 = all selling.
    // floorUsd damps noise when volume is thin (a lone $50 trade shouldn't pin the bar).
    snapshot(now = Date.now()) {
      decay(now);
      const total = buy + sell;
      return {
        pressure: total > 0 ? (buy - sell) / Math.max(total, floorUsd) : 0,
        buyUsd: buy,
        sellUsd: sell,
      };
    },
    reset() { buy = sell = 0; },
  };
}
