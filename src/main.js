// App wiring: market data → round logic → scene + renderer → DOM HUD.
// URL params: ?demo=1 force DEMO · ?fast=1 ±$30 rounds + frequent whales (testing)
//             ?range=150 fixed half-range (default: adaptive on live data, $150 in DEMO)
//             ?lang=ru|en · ?debug=1 readout · ?source=agg|binance|bybit|coinbase (overrides saved choice)
//             ?feeds=binance,bybit,coinbase,liquidations  only open these sockets (fallback testing)
//             ?delay=binance:5000  open a venue's socket late (tests late joiners in AGG)
import { createMarket, SOURCES } from './market/market.js';
import { createSourceMenu } from './source-menu.js';
import { createRound } from './game/round.js';
import { createScene, W } from './game/scene.js';
import { createRenderer, fitCanvas } from './game/renderer.js';
import { preloadAll } from './game/sprites-cache.js';
import { createHud } from './hud.js';
import { t, applyDom, setLang, toggleLang, onLangChange, formatUsd } from './i18n.js';
import { initTelegram, haptic, hapticSelection, notify } from './tg.js';
import { isSoundEnabled, toggleSound, unlock as unlockAudio, play } from './audio.js';

// ---------- config ----------
const params = new URLSearchParams(location.search);
const flag = (name) => params.has(name) && !['0', 'false'].includes(params.get(name));
const DEMO = flag('demo');
const FAST = flag('fast');
const DEBUG = flag('debug');
const FIXED_RANGE = Number(params.get('range')) > 0 ? Number(params.get('range')) : null;
const feedsParam = params.get('feeds');
const enabledFeeds = Object.fromEntries(['binance', 'bybit', 'coinbase', 'liquidations']
  .map((f) => [f, !feedsParam || feedsParam.split(',').includes(f)]));
const delays = Object.fromEntries((params.get('delay') || '').split(',').filter(Boolean)
  .map((pair) => pair.split(':')).map(([k, v]) => [k, Number(v) || 0]));
const SOURCE_KEY = 'sb.source';
function initialSource() {
  const fromUrl = (params.get('source') || '').toUpperCase();
  if (SOURCES.includes(fromUrl)) return fromUrl;
  try {
    const saved = localStorage.getItem(SOURCE_KEY);
    if (SOURCES.includes(saved)) return saved;
  } catch { /* storage blocked */ }
  return 'AGG';
}
const reducedMotion = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
const WIDE_MIN_VW = 820;
const CELEBRATION_MS = FAST ? 2500 : 3200;
const EXCHANGE_NAMES = { binance: 'Binance', bybit: 'Bybit', coinbase: 'Coinbase' };

// ---------- setup ----------
initTelegram({ headerColor: '#10142a', backgroundColor: '#10142a' });
if (params.get('lang')) setLang(params.get('lang'), { persist: false });
applyDom();
preloadAll();

const $ = (id) => document.getElementById(id);
const hud = createHud();
const market = createMarket({
  demo: DEMO, enabledFeeds, delays, source: initialSource(), whaleIntervalSec: FAST ? [8, 20] : [40, 120],
});
const round = createRound({ celebrationMs: CELEBRATION_MS, scoreBucket: DEMO ? 'demo' : 'live' });
const scene = createScene({
  reducedMotion,
  hooks: {
    onThrow: (team, kind) => { if (kind === 'small') play('throw', { intensity: 0.3 }); },
    onImpact: (kind, hit) => {
      if (kind === 'small') { if (hit) play('splat', { intensity: 0.4 }); } else play('bigSplat', { intensity: kind === 'giant' ? 1 : 0.5 });
    },
  },
});
const renderer = createRenderer($('field'), scene);
window.__sb = { market, round, scene, hud };

let source = null;
let pressure = 0;
let fontsReady = false;
applyRangePolicy(DEMO ? 'DEMO' : null);
hud.setScore(round.state.score);

// ---------- range policy / score buckets ----------
function applyRangePolicy(src) {
  const demoLike = src === 'DEMO';
  if (FAST) round.configure({ adaptive: false, halfRange: 30, minHalf: 10 });
  else if (FIXED_RANGE) round.configure({ adaptive: false, halfRange: FIXED_RANGE });
  else if (demoLike) round.configure({ adaptive: false, halfRange: 150 });
  else round.configure({ adaptive: true, halfRange: 100, minHalf: 40 });
  round.configure({ scoreBucket: demoLike ? 'demo' : 'live' });
}

// ---------- layout ----------
const appEl = $('app');
const stageEl = $('stage');
let layoutQueued = false;

function layout() {
  layoutQueued = false;
  const cs = getComputedStyle(appEl);
  const contentW = appEl.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  const contentH = appEl.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  // Side-panel layout on wide screens and on landscape-ish viewports (landscape phones, short
  // desktop panes) where top/bottom overlays would squeeze the field.
  const wide = vw >= WIDE_MIN_VW || (vw >= 560 && vw > vh * 0.95);
  hud.setLayout(wide ? 'wide' : 'phone');
  const sideW = wide ? $('side').offsetWidth + 16 : 0;
  const availW = Math.min(520, contentW - sideW - (wide ? 16 : 0));
  const availH = wide ? contentH - 16 : contentH;
  const { H, css } = fitCanvas(availW, availH, window.devicePixelRatio || 1);
  renderer.setSize(H, css);
  stageEl.style.width = `${W * css}px`;
  stageEl.style.height = `${H * css}px`;
  // The HUD is sized in CSS px; convert what it covers into logical px and keep the whole
  // field (end zones, flags, rows, giants, crown) inside the visible band between overlays.
  const ins = hud.measureInsets();
  const insetTop = ins.top > 0 ? Math.ceil(ins.top / css) + 1 : 0;
  const insetBottom = ins.bottom > 0 ? Math.ceil(ins.bottom / css) + 1 : 0;
  if (!scene.state.kids.length) scene.init(H, insetTop, insetBottom);
  else scene.resize(H, insetTop, insetBottom);
  renderer.draw(round); // resizing clears the canvas; repaint now instead of on the next frame
}
const queueLayout = () => {
  if (layoutQueued) return;
  layoutQueued = true;
  requestAnimationFrame(layout);
};
window.addEventListener('resize', queueLayout);
new ResizeObserver(queueLayout).observe(appEl);
layout();

// ---------- loading state ----------
function updateLoading() {
  hud.setLoading(!(fontsReady && market.getPrice() != null));
}
Promise.race([
  Promise.all([document.fonts.load('16px "Press Start 2P"'), document.fonts.load('16px Tiny5')]),
  new Promise((r) => setTimeout(r, 3000)),
]).catch(() => {}).finally(() => { fontsReady = true; updateLoading(); });
updateLoading();

// ---------- feed rows ----------
const signed = (side, usd) => `${side === 'buy' ? '+' : '-'}${formatUsd(usd)}`;

function bigprintRow(bp) {
  const dir = bp.side === 'buy' ? 'Buy' : 'Sell';
  const cls = bp.side === 'buy' ? 'buy' : 'sell';
  const vars = { ex: EXCHANGE_NAMES[bp.exchange] ?? '' };
  if (bp.kind === 'whale') {
    return { icon: ['whale', 'green', 2], key: `feed.whale${dir}`, amount: signed(bp.side, bp.usd), amountCls: 'whale' };
  }
  if (bp.kind === 'liquidation') {
    // forced SELL = longs liquidated (helps red); forced BUY = shorts liquidated (helps green)
    return { icon: ['icon_bolt', 'green', 2], key: bp.side === 'sell' ? 'feed.liqLong' : 'feed.liqShort', vars, amount: formatUsd(bp.usd), amountCls: 'gold' };
  }
  const giant = bp.tier === 'giant';
  const key = bp.synthetic
    ? `feed.demo${giant ? 'Giant' : ''}${dir}`
    : `feed.${giant ? 'giant' : 'big'}${dir}`;
  const icon = giant ? ['ball_big', 'green', 1]
    : bp.side === 'buy' ? ['icon_head_back', 'green', 1] : ['icon_head_front', 'red', 1];
  return { icon, key, vars, amount: signed(bp.side, bp.usd), amountCls: cls };
}

// ---------- market events ----------
market.on('price', ({ price, change24h }) => {
  hud.setPrice(price);
  hud.setChange(change24h);
  updateLoading();
});

market.on('status', (st) => {
  const prev = source;
  source = st.source;
  hud.setSource(st);
  menu?.render();
  const userSwitch = st.reason === 'user';
  if ((prev === source && !userSwitch) || source === null) return;
  const wasDemo = prev === 'DEMO';
  const isDemo = source === 'DEMO';
  if (prev === null || wasDemo !== isDemo) {
    applyRangePolicy(source);
    hud.setScore(round.state.score);
  }
  if (prev !== null && prev !== source) {
    hud.pushFeed({ icon: null, key: 'feed.source', vars: { src: t(`src.${source}`) }, amount: '' });
  }
  // A DEMO↔live switch or a user source change jumps the price: start a fresh round (no
  // score) instead of awarding a win. Automatic venue joins/drops are smoothed in market.js.
  if (prev !== null && (wasDemo !== isDemo || userSwitch)) {
    round.configure({ clearVolatility: true });
    const price = market.getPrice();
    const ev = price && round.restart(price);
    if (ev) handleRoundEvents([ev]);
  }
});

market.on('flow', (f) => {
  pressure = f.pressure;
  hud.setPressure(pressure);
});

market.on('walls', (w) => hud.setWalls(w));

// While the page is hidden the scene is frozen, so don't pile up throws/giants for it.
// (__sb.forceActive lets headless tests drive the scene with __sb.step().)
const sceneActive = () => !document.hidden || window.__sb.forceActive;

market.on('trade', (tr) => {
  if (sceneActive()) scene.trade(tr.side, tr.usd);
});

market.on('bigprint', (bp) => {
  hud.pushFeed(bigprintRow(bp));
  const giant = bp.tier === 'giant';
  haptic(bp.usd >= 5_000_000 ? 'heavy' : giant ? 'medium' : 'light');
  if (!sceneActive()) return;
  scene.bigprint(bp);
  if (giant && !scene.state.winner) play('giant', { intensity: Math.min(1, bp.usd / 5_000_000) });
});

// ---------- round events ----------
function handleRoundEvents(events) {
  for (const ev of events) {
    if (ev.type === 'victory') {
      scene.victory(ev.winner);
      hud.showBanner(ev.winner, ev.roundNo, CELEBRATION_MS - 400);
      hud.setScore(ev.score);
      hud.pushFeed({
        icon: ['crown', 'green', 2],
        key: ev.winner === 'green' ? 'feed.greenWins' : 'feed.redWins',
        vars: { n: ev.roundNo },
        amount: `${ev.score.green}:${ev.score.red}`,
        amountCls: 'gold',
      });
      notify('success');
      play('victory');
    } else if (ev.type === 'start') {
      scene.newRound();
      hud.setRoundOpen(ev.center);
    }
  }
}

// ---------- controls ----------
const soundBtn = $('btn-sound');
const langBtn = $('btn-lang');
function renderControls() {
  const on = isSoundEnabled();
  soundBtn.setAttribute('aria-pressed', String(on));
  soundBtn.setAttribute('aria-label', t(on ? 'sound.on' : 'sound.off'));
  soundBtn.title = t(on ? 'sound.on' : 'sound.off');
  langBtn.textContent = t('lang.toggle');
  langBtn.setAttribute('aria-label', t('lang.aria'));
}
soundBtn.addEventListener('click', () => {
  toggleSound();
  renderControls();
  play('throw');
});
langBtn.addEventListener('click', () => toggleLang());

// Data-source menu (badge → popover / bottom sheet) + side-panel venue list
const menu = createSourceMenu({
  market,
  onSelect(src) {
    try { localStorage.setItem(SOURCE_KEY, src); } catch { /* ignore */ }
    hapticSelection();
    market.setSource(src);
  },
  onToggleSound() {
    toggleSound();
    renderControls();
    play('throw');
  },
  onToggleLang: () => toggleLang(),
  isSoundOn: isSoundEnabled,
});
menu.mountList($('venues-list'));
$('source').addEventListener('click', (e) => menu.toggle(e.currentTarget));
setInterval(() => { if (document.documentElement.dataset.layout === 'wide' && !document.hidden) menu.render(); }, 1000);
onLangChange(() => {
  applyDom();
  hud.renderLang();
  renderControls();
  menu.render();
});
window.addEventListener('pointerdown', unlockAudio, { passive: true });
window.addEventListener('keydown', unlockAudio);
renderControls();

// ---------- loops ----------
// Round logic ticks every frame; a 500 ms timer keeps it going while rAF is paused (hidden page).
let lastLogic = performance.now();
function tickLogic(now) {
  const dt = (now - lastLogic) / 1000;
  lastLogic = now;
  handleRoundEvents(round.update(market.getPrice(), dt));
}
setInterval(() => {
  const now = performance.now();
  if (now - lastLogic > 450) tickLogic(now);
}, 500);

let rafId = 0;
let lastFrame = performance.now();
let fps = 60;
function frame(now) {
  const dt = Math.min(0.05, Math.max(0, (now - lastFrame) / 1000));
  lastFrame = now;
  if (dt > 0) fps += (1 / dt - fps) * 0.05;
  if (!window.__sb.paused) { // __sb.paused freezes the view for inspection (use __sb.step)
    tickLogic(now);
    scene.update(dt, { borderT: round.state.borderT, pressure });
    renderer.draw(round);
  }
  rafId = requestAnimationFrame(frame);
}
// Console/test helper: advance the simulation synchronously (works while the page is hidden).
window.__sb.step = (seconds = 1, dt = 1 / 60) => {
  for (let i = 0; i < seconds / dt; i++) {
    lastLogic -= dt * 1000; // make round logic see the same dt
    tickLogic(performance.now());
    scene.update(dt, { borderT: round.state.borderT, pressure });
  }
  renderer.draw(round);
};

document.addEventListener('visibilitychange', () => {
  cancelAnimationFrame(rafId);
  if (!document.hidden) {
    lastFrame = performance.now();
    rafId = requestAnimationFrame(frame);
  }
});

if (DEBUG) {
  const dbg = $('debug');
  dbg.hidden = false;
  setInterval(() => {
    const r = round.state;
    const f = market.getFlow();
    const vol = round.volatility;
    dbg.textContent = [
      `${fps.toFixed(0)} fps  src=${source ?? '…'}${market.getSimRegime() ? ` ${market.getSimRegime()}` : ''}`,
      `round #${r.roundNo} ${r.phase} ±${r.halfRange}`,
      `${r.low.toFixed(0)}–${r.high.toFixed(0)} T=${r.borderT.toFixed(2)}`,
      `p=${f.pressure.toFixed(2)} vol=${vol ? vol.toFixed(1) : '—'}`,
      `ws ${Object.entries(market.getFeeds()).map(([k, v]) => `${k.slice(0, 4)}${v ? '+' : '-'}`).join(' ')}`,
      `offset ${market.getPriceOffset().toFixed(2)}`,
    ].join('\n');
  }, 250);
}

market.start();
rafId = requestAnimationFrame(frame);
