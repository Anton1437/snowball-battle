// DOM HUD (DESIGN.md §8): price, 24h %, source badge, pressure bar, score, walls, feed,
// legend, victory banner, loading state. Panels are CSS-px sized (independent of the canvas
// scale) and moved between the on-field overlays (portrait phone) and the side panel (wide)
// by setLayout(). measureInsets() reports how much of the field the overlays cover.
import { t, formatPrice, formatUsd, formatChange } from './i18n.js?v=17c4945d';
import { spriteDataUrl } from './game/sprites-cache.js?v=17c4945d';

const FEED_MAX = 6;
const FEED_COLLAPSED = 2;
const FEED_AUTO_COLLAPSE_MS = 10000;
const FEED_OPACITY = [1, 0.85, 0.7, 0.55, 0.45, 0.35];
const FLASH_MS = 300;
const BANNER_POP = [{ transform: 'scale(0.2)' }, { transform: 'scale(1)' }];
const BANNER_POP_OPTS = { duration: 240, easing: 'steps(3, jump-end)' }; // no fill: rests at scale(1)

const $ = (id) => document.getElementById(id);

function icon(name, team, scale) {
  const img = new Image();
  img.src = spriteDataUrl(name, team, scale);
  img.alt = '';
  img.className = 'px-icon';
  return img;
}

export function createHud() {
  const el = {
    stage: $('stage'),
    hudTop: $('hud-top'),
    hudRow: $('hud-row'),
    hudBottom: $('hud-bottom'),
    ticker: $('ticker'),
    controls: $('controls'),
    slotScore: $('slot-score'),
    slotTop: $('slot-top'),
    side: $('side'),
    sideHead: $('side-head'),
    titlePanel: $('title-panel'),
    legendPanel: $('legend-panel'),
    venuesPanel: $('venues-panel'),
    price: $('price'),
    change: $('change'),
    source: $('source'),
    sourceText: $('source-text'),
    pressurePanel: $('pressure-panel'),
    pressureFill: $('pressure-fill'),
    pressureBuy: $('pressure-buy'),
    pressureSell: $('pressure-sell'),
    scorePanel: $('score-panel'),
    scoreGreen: $('score-green'),
    scoreRed: $('score-red'),
    wallsPanel: $('walls-panel'),
    wallBid: $('wall-bid'),
    wallAsk: $('wall-ask'),
    feedPanel: $('feed-panel'),
    feed: $('feed'),
    feedMore: $('feed-more'),
    banner: $('banner'),
    bannerTitle: $('banner-title'),
    bannerSub: $('banner-sub'),
    loading: $('loading'),
    loadingText: $('loading-text'),
  };

  // Pixel icons from the sprite sheet
  const scoreIconG = icon('icon_head_back', 'green', 2);
  const scoreIconR = icon('icon_head_front', 'red', 2);
  scoreIconG.classList.add('score-ic');
  scoreIconR.classList.add('score-ic');
  $('score-icon-green').replaceWith(scoreIconG);
  $('score-icon-red').replaceWith(scoreIconR);
  $('loading-icon').replaceWith(icon('ball_big', 'green', 4));
  el.legendPanel.querySelectorAll('[data-icon]').forEach((span) => {
    const [name, team, scale] = span.dataset.icon.split(':');
    span.append(icon(name, team, Number(scale)));
  });

  const feed = [];
  let mode = 'phone';
  let feedExpanded = false;
  let feedCollapseTimer = 0;
  let lastPriceText = '';
  let lastPrice = null;
  let roundOpen = null;
  let flashTimer = 0;
  let bannerHideTimer = 0;
  let bannerAnim = null;
  let pressurePct = 50;
  let status = { source: null, liveCount: 0 };
  let score = { green: 0, red: 0 };
  let change = null;

  // ---------- price ----------
  function settlePriceColor() {
    el.price.classList.remove('flash-up', 'flash-down');
    const vsOpen = roundOpen != null && lastPrice != null ? Math.sign(lastPrice - roundOpen) : 0;
    el.price.classList.toggle('up', vsOpen > 0);
    el.price.classList.toggle('down', vsOpen < 0);
  }

  function setPrice(price) {
    const text = formatPrice(price);
    if (text === lastPriceText) return;
    const dir = lastPrice == null ? 0 : Math.sign(price - lastPrice);
    lastPriceText = text;
    lastPrice = price;
    el.price.textContent = text;
    if (dir) {
      el.price.classList.remove('up', 'down', 'flash-up', 'flash-down');
      el.price.classList.add(dir > 0 ? 'flash-up' : 'flash-down');
      clearTimeout(flashTimer);
      flashTimer = setTimeout(settlePriceColor, FLASH_MS);
    }
  }

  function setRoundOpen(p) {
    roundOpen = p;
    settlePriceColor();
  }

  function setChange(pct) {
    change = pct;
    if (!Number.isFinite(pct)) {
      el.change.textContent = '';
      return;
    }
    el.change.textContent = `${formatChange(pct)} ${t('change.suffix')}`;
    el.change.className = `chg ${pct >= 0 ? 'up' : 'down'}`;
  }

  // ---------- source badge (a button that opens the source menu) ----------
  // st: market status { source, liveCount }. AGG shows the live venue count: "AGG ·3".
  function setSource(st) {
    status = st;
    const src = st.source;
    const state = src === null ? 'connecting' : src === 'DEMO' ? 'demo' : 'live';
    el.source.dataset.state = state;
    el.sourceText.textContent = src === null ? t('src.connecting')
      : src === 'AGG' ? `${t('src.AGG')} ·${st.liveCount}` : t(`src.${src}`);
    el.source.title = src === 'DEMO' ? t('demo.hint') : t('menu.open');
    el.source.setAttribute('aria-label', `${t('menu.open')}: ${el.sourceText.textContent}`);
  }

  // ---------- pressure ----------
  function setPressure(p) {
    const pct = Math.round(((p + 1) / 2) * 100);
    if (pct === pressurePct) return;
    pressurePct = pct;
    renderPressure();
  }

  function renderPressure() {
    el.pressureFill.style.width = `${pressurePct}%`;
    el.pressureBuy.textContent = `${t('pressure.buy')} ${pressurePct}%`;
    el.pressureSell.textContent = `${100 - pressurePct}% ${t('pressure.sell')}`;
    el.pressurePanel.setAttribute('aria-label', t('pressure.aria', { buy: pressurePct, sell: 100 - pressurePct }));
  }

  // ---------- score / walls ----------
  function setScore(sc) {
    score = { ...sc };
    el.scoreGreen.textContent = sc.green;
    el.scoreRed.textContent = sc.red;
    el.scorePanel.setAttribute('aria-label', t('score.aria', { g: sc.green, r: sc.red }));
  }

  function setWalls(w) {
    el.wallBid.textContent = w ? formatUsd(w.bidUsd) : '—';
    el.wallAsk.textContent = w ? formatUsd(w.askUsd) : '—';
  }

  // ---------- feed ----------
  const visibleFeedRows = () => (mode === 'phone' && !feedExpanded ? FEED_COLLAPSED : FEED_MAX);

  // entry: { icon:[name, team, scale], key, vars, amount, amountCls }
  function pushFeed(entry) {
    feed.unshift(entry);
    if (feed.length > FEED_MAX) feed.length = FEED_MAX;
    renderFeed(true);
  }

  function renderFeed(animateFirst = false) {
    const n = visibleFeedRows();
    const rows = feed.slice(0, n);
    const hiddenCount = Math.max(0, feed.length - n);
    el.feedMore.textContent = mode === 'phone' ? (feedExpanded ? '-' : hiddenCount ? `+${hiddenCount}` : '') : '';
    if (!rows.length) {
      const li = document.createElement('li');
      li.className = 'frow empty';
      li.textContent = t('feed.empty');
      el.feed.replaceChildren(li);
      return;
    }
    el.feed.replaceChildren(...rows.map((e, i) => {
      const li = document.createElement('li');
      li.className = `frow${animateFirst && i === 0 ? ' enter' : ''}`;
      li.style.opacity = FEED_OPACITY[i];
      const ic = document.createElement('span');
      ic.className = 'ic';
      if (e.icon) ic.append(icon(...e.icon));
      const tx = document.createElement('span');
      tx.className = 'tx';
      tx.textContent = t(e.key, e.vars);
      const amt = document.createElement('span');
      amt.className = `amt ${e.amountCls || ''}`;
      amt.textContent = e.amount || '';
      li.append(ic, tx, amt);
      return li;
    }));
  }

  function setFeedExpanded(on) {
    feedExpanded = on && mode === 'phone';
    el.feedPanel.setAttribute('aria-expanded', String(feedExpanded));
    el.feedPanel.classList.toggle('expanded', feedExpanded);
    clearTimeout(feedCollapseTimer);
    if (feedExpanded) feedCollapseTimer = setTimeout(() => setFeedExpanded(false), FEED_AUTO_COLLAPSE_MS);
    renderFeed();
  }
  // Tap the phone feed to expand it over the field; tap again (or wait 10 s) to collapse.
  el.feedPanel.addEventListener('click', () => { if (mode === 'phone') setFeedExpanded(!feedExpanded); });
  el.feedPanel.setAttribute('title', t('feed.expand'));

  // ---------- banner ----------
  // The resting style is full size; the pop is a Web Animation with no fill, so if animations
  // are throttled/paused (hidden webview, background tab) it can never leave the banner small.
  function showBanner(winner, roundNo, holdMs = 2800) {
    const title = t(winner === 'green' ? 'banner.greenWins' : 'banner.redWins');
    el.bannerTitle.textContent = title;
    el.bannerSub.textContent = t('banner.round', { n: roundNo });
    // Press Start 2P in multiples of 8 px; as large as fits ~92% of the column width.
    const w = el.stage.clientWidth || 360;
    const size = Math.max(8, Math.min(32, Math.floor((0.92 * w) / title.length / 8) * 8));
    el.bannerTitle.style.fontSize = `${size}px`;
    el.banner.className = `banner ${winner}`;
    el.banner.hidden = false;
    bannerAnim?.cancel();
    bannerAnim = null;
    const reduced = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (!document.hidden && !reduced && el.banner.animate) {
      bannerAnim = el.banner.animate(BANNER_POP, BANNER_POP_OPTS);
    }
    clearTimeout(bannerHideTimer);
    bannerHideTimer = setTimeout(hideBanner, holdMs);
  }

  function hideBanner() {
    bannerAnim?.cancel();
    bannerAnim = null;
    el.banner.hidden = true;
  }

  // ---------- loading ----------
  function setLoading(on) {
    el.loading.hidden = !on;
    el.loadingText.textContent = t('loading');
  }

  // ---------- layout ----------
  // 'phone': ticker + score + controls and the pressure bar overlay the top of the field, the
  // feed (2 rows, tap to expand) overlays the bottom. 'wide': everything lives in the side panel.
  function setLayout(nextMode) {
    mode = nextMode;
    document.documentElement.dataset.layout = mode;
    if (mode === 'wide') {
      setFeedExpanded(false);
      el.sideHead.append(el.ticker, el.controls);
      el.side.append(el.titlePanel, el.sideHead, el.scorePanel, el.pressurePanel, el.feedPanel, el.wallsPanel,
        el.venuesPanel, el.legendPanel);
    } else {
      el.hudRow.append(el.ticker, el.slotScore, el.controls);
      el.slotScore.append(el.scorePanel);
      el.slotTop.append(el.pressurePanel);
      el.hudBottom.append(el.feedPanel);
      setFeedExpanded(false);
    }
    renderFeed();
  }

  // CSS px of the field covered by the top / bottom overlays (collapsed feed).
  function measureInsets() {
    if (mode === 'wide') return { top: 0, bottom: 0 };
    const stage = el.stage.getBoundingClientRect();
    const top = el.hudTop.getBoundingClientRect();
    const bottom = el.hudBottom.getBoundingClientRect();
    return {
      top: Math.max(0, top.bottom - stage.top),
      bottom: Math.max(0, stage.bottom - bottom.top),
    };
  }

  function renderLang() {
    setSource(status);
    setChange(change);
    renderPressure();
    setScore(score);
    renderFeed();
    el.feedPanel.setAttribute('title', t('feed.expand'));
    if (!el.loading.hidden) setLoading(true);
  }

  renderPressure();
  setWalls(null);
  renderFeed();

  return {
    setPrice, setRoundOpen, setChange, setSource, setPressure, setScore, setWalls,
    pushFeed, showBanner, hideBanner, setLoading, setLayout, measureInsets, renderLang,
    get feedExpanded() { return feedExpanded; },
  };
}
