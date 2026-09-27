// DEMO market: regime-switching random walk + synthetic trades with heavy-tailed sizes.
// Tuned (at ~$85k) so a ±$150 round is usually decided within 1–3 minutes.

const TICK_MS = 200;
const REF_PRICE = 85000;

const REGIMES = [
  // weight, duration range (s), drift range ($/s, sign randomized for trends), vol ($/√s), trade rate (/s), size multiplier
  { name: 'calm',  weight: 0.40, dur: [10, 30], drift: [0, 0.4], vol: 7,  rate: 6,  size: 1 },
  { name: 'trend', weight: 0.45, dur: [15, 45], drift: [1.5, 4], vol: 9,  rate: 10, size: 1.5 },
  { name: 'burst', weight: 0.15, dur: [3, 8],   drift: [4, 12],  vol: 25, rate: 25, size: 3 },
];

const rand = (a, b) => a + Math.random() * (b - a);
const gauss = () => {
  const u = 1 - Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * Math.random());
};

function poisson(lambda) {
  // Knuth; lambda here is small (< ~10 per tick)
  const L = Math.exp(-lambda);
  let k = 0;
  let p = 1;
  do { k++; p *= Math.random(); } while (p > L);
  return k - 1;
}

// Pareto(xm=150, alpha=0.95), capped: median ≈ $310, P(≥$250k) ≈ 0.09%, P(≥$1M) ≈ 0.02%.
function tradeUsd(mult) {
  const usd = 150 * Math.pow(1 - Math.random(), -1 / 0.95) * mult;
  return Math.min(usd, 4_000_000);
}

function pickRegime() {
  let r = Math.random();
  for (const g of REGIMES) {
    if ((r -= g.weight) <= 0) return g;
  }
  return REGIMES[0];
}

export function createSim({ startPrice = REF_PRICE, onPrice, onTrade, onWalls }) {
  let price = startPrice;
  const baseChange = rand(-3, 3);
  const open24h = startPrice / (1 + baseChange / 100);
  let regime = null;
  let drift = 0;
  let regimeUntil = 0;
  let lastWalls = 0;

  function nextRegime(now) {
    regime = pickRegime();
    const dir = Math.random() < 0.5 ? -1 : 1;
    drift = dir * rand(regime.drift[0], regime.drift[1]);
    regimeUntil = now + rand(regime.dur[0], regime.dur[1]) * 1000;
  }

  function tick() {
    const now = Date.now();
    if (now >= regimeUntil) nextRegime(now);
    const dt = TICK_MS / 1000;
    const scale = price / REF_PRICE;
    const dp = (drift * dt + regime.vol * Math.sqrt(dt) * gauss()) * scale;
    price = Math.max(1000, price + dp);

    // Aggressor side leans with drift and with this tick's move.
    const pBuy = Math.min(0.9, Math.max(0.1, 0.5 + drift * 0.05 + Math.sign(dp) * 0.12));
    const n = poisson(regime.rate * dt);
    for (let i = 0; i < n; i++) {
      const usd = tradeUsd(regime.size);
      onTrade({
        exchange: 'demo',
        side: Math.random() < pBuy ? 'buy' : 'sell',
        price,
        qty: usd / price,
        usd,
        ts: now,
      });
    }

    onPrice({ price, change24h: ((price - open24h) / open24h) * 100 });

    if (now - lastWalls > 500) {
      lastWalls = now;
      const tilt = Math.max(-0.5, Math.min(0.5, drift * 0.06));
      onWalls({
        bidUsd: Math.max(3e4, 4e5 * (1 + tilt) * (1 + 0.25 * gauss())),
        askUsd: Math.max(3e4, 4e5 * (1 - tilt) * (1 + 0.25 * gauss())),
      });
    }
  }

  nextRegime(Date.now());
  tick();
  const timer = setInterval(tick, TICK_MS);

  return {
    get price() { return price; },
    get regime() { return regime.name; },
    close() { clearInterval(timer); },
  };
}
