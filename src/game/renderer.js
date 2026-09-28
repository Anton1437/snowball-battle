// Canvas renderer for the scene at logical resolution 192 × H (DESIGN.md §4–§6, §9).
// Layers: ground → front line → y-sorted actors/props → balls → FX  (all shaken)
//         → price axis → snowflakes (not shaken). The DOM HUD sits on top.
import { SPRITES, PALETTE, UI, drawSprite, frames, loopFrame, makeCanvas, miniText, miniTextWidth } from './sprites-cache.js?v=43edfa8d';
import { W, AXIS_X, FIELD_W } from './scene.js?v=43edfa8d';
import { axisLevels, signLabel } from './round.js?v=43edfa8d';
import { drawKidLook, drawYouMarker, clampPetPos } from './kid-art.js?v=43edfa8d';

const H_MIN = 256;
const H_MAX = 420;
const TILE_NAMES = ['snow_tile_a', 'snow_tile_b', 'snow_tile_c'];
const POST_XS = [12, 44, 76, 108, 140];
const FORT_XS = [28, 84, 140];
const TRENCH_ROWS = [[-2, 'b'], [-1, 'B'], [0, 'n'], [1, 'n'], [2, 'B'], [3, 'w'], [4, 'b']];
const TRENCH_ORIGIN = 9;   // strip row of the line's y
const ROPE_ORIGIN = 6;
const MAX_DRAWABLES = 64;
// Precomputed sprite names so the frame loop doesn't build strings.
const KID_STATES = ['idle', 'windup', 'throw', 'hit', 'cheer', 'duck'];
const KID_NAMES = {};
for (const view of ['front', 'back']) {
  KID_NAMES[view] = {};
  for (const st of KID_STATES) KID_NAMES[view][st] = `kid_${view}_${st}`;
}
const GIANT_NAMES = {
  front: { idle: 'giant_front_idle', throw: 'giant_front_throw' },
  back: { idle: 'giant_back_idle', throw: 'giant_back_throw' },
};

// Deterministic hash → [0, 1)
const hash = (a, b = 0, c = 0) => {
  let h = (a * 374761393 + b * 668265263 + c * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};

// Fit a 192 × H canvas into the available CSS box (DESIGN.md §9).
// Integer scale where it doesn't waste much; fractional fill on dense (DPR ≥ 2) phones or when < 2×.
export function fitCanvas(availW, availH, dpr = 1) {
  const H0 = Math.min(H_MAX, Math.max(H_MIN, Math.round((W * availH) / availW)));
  const cssFit = Math.min(availW / W, availH / H0);
  let css = cssFit;
  if (dpr < 2) {
    const k = Math.floor(cssFit);
    if (k >= 2) css = k;
  } else {
    const dev = cssFit * dpr;
    const k = Math.floor(dev);
    if (k / dev >= 0.9) css = k / dpr;
  }
  const H = Math.min(H_MAX, Math.max(H_MIN, Math.floor(availH / css)));
  return { H, css };
}

export function createRenderer(canvas, scene) {
  const ctx = canvas.getContext('2d', { alpha: false });
  const s = scene.state;
  let groundCache = null;
  let trenchCache = null;
  let ropeCache = null;
  let cachedSeed = -1;
  let axisLow = 0;
  let axisHigh = 0;
  let axisH = 0;
  let axis = [];
  const drawables = [];
  for (let i = 0; i < MAX_DRAWABLES; i++) drawables.push({ key: 0, idx: 0, kind: '', ref: null, name: '', team: '', frame: 0, x: 0, y: 0 });
  let nDraw = 0;
  const sortFn = (a, b) => a.key - b.key || a.idx - b.idx;
  const geomKey = () => s.H + s.top * 1e3 + s.bot * 1e6; // numeric cache key, no allocation

  function setSize(H, css) {
    canvas.width = W;
    canvas.height = H;
    canvas.style.width = `${W * css}px`;
    canvas.style.height = `${H * css}px`;
    ctx.imageSmoothingEnabled = false;
    groundCache = null;
    axisH = 0;
  }

  // ---------- cached layers ----------
  function px(g, x, y, ch) {
    g.fillStyle = PALETTE[ch];
    g.fillRect(x, y, 1, 1);
  }

  function buildGround() {
    const c = makeCanvas(W, s.H);
    const g = c.getContext('2d');
    for (let ty = 0; ty < s.H; ty += 16) {
      for (let tx = 0; tx < W; tx += 16) {
        const r = hash(tx, ty, 3);
        drawSprite(g, r < 0.6 ? TILE_NAMES[0] : r < 0.8 ? TILE_NAMES[1] : TILE_NAMES[2], tx, ty);
      }
    }
    for (let x = 0; x < AXIS_X; x += 2) {
      px(g, x, s.top + s.Z, 'b');
      px(g, x, s.bot - s.Z, 'b');
    }
    c.key = geomKey();
    return c;
  }

  function buildTrench() {
    const c = makeCanvas(FIELD_W, TRENCH_ORIGIN * 2 + 1);
    const g = c.getContext('2d');
    const seed = s.seed;
    for (let x = 0; x < FIELD_W; x++) {
      const yb = TRENCH_ORIGIN + s.wob[x];
      for (let dy = -8; dy <= 8; dy++) {
        if (dy > -4 && dy < 6) continue;
        if (hash(x, dy, seed) < 0.1 * (1 - Math.abs(dy) / 10)) px(g, x, yb + dy, 'b');
      }
      for (const [dy, ch] of TRENCH_ROWS) px(g, x, yb + dy, ch);
      if (hash(x, 9, seed) < 0.45) px(g, x, yb - 3, 'b');
      if (hash(x, 11, seed) < 0.3) px(g, x, yb + 5, 'b');
    }
    return c;
  }

  function buildRope() {
    const c = makeCanvas(FIELD_W, ROPE_ORIGIN + 8);
    const g = c.getContext('2d');
    const topY = (x) => ROPE_ORIGIN + s.wob[x] - 2;
    for (let i = 0; i < POST_XS.length - 1; i++) {
      const a = POST_XS[i];
      const b = POST_XS[i + 1];
      for (let x = a + 1; x < b; x++) {
        const t = (x - a) / (b - a);
        const y = Math.round(topY(a) + (topY(b) - topY(a)) * t + 2 * Math.sin(Math.PI * t));
        px(g, x, y, 'e');
        if ((x - a) % 6 === 3 && x < b - 2) {
          const ch = Math.floor((x - a) / 6) % 2 ? 'j' : 'y';
          px(g, x, y + 1, ch);
          px(g, x + 1, y + 1, ch);
          px(g, x, y + 2, ch);
        }
      }
    }
    for (const x of POST_XS) drawSprite(g, 'border_post', x, ROPE_ORIGIN + s.wob[x] + 3);
    return c;
  }

  function ensureCaches() {
    if (!groundCache || groundCache.key !== geomKey()) groundCache = buildGround();
    if (cachedSeed !== s.seed) {
      trenchCache = buildTrench();
      ropeCache = buildRope();
      cachedSeed = s.seed;
    }
  }

  // ---------- y-sorted drawables ----------
  function add(key, kind, name, team, frame, x, y, ref = null) {
    if (nDraw >= MAX_DRAWABLES) return;
    const d = drawables[nDraw];
    d.key = key; d.idx = nDraw; d.kind = kind; d.name = name; d.team = team; d.frame = frame;
    d.x = x; d.y = y; d.ref = ref;
    nDraw++;
  }

  function kidFrame(k, t) {
    switch (k.state) {
      case 'idle': return Math.floor((t + k.phase) * 2) % 2;
      case 'throw': return k.t < 0.1 ? 0 : 1;
      case 'hit': return Math.min(1, Math.floor(k.t * 8));
      case 'cheer': return Math.floor((t + k.phase) * 6) % 2;
      case 'duck': return Math.floor((t + k.phase) * 2) % 2;
      default: return 0;
    }
  }

  // Giant sequence (DESIGN.md §7): idle → throw f0 (1.1 s) → f1 release (1.5 s) → f2 → idle.
  const giantThrowFrame = (g) => (g.t < 1.1 || g.t >= 1.95 ? -1 : g.t < 1.5 ? 0 : g.t < 1.65 ? 1 : 2);

  function collect(t) {
    nDraw = 0;
    // DESIGN §4 decor, with "0" = top of the visible band and "H" = its bottom
    const { Z, top: T, bot: B } = s;
    add(T + Z - 4, 'sprite', 'flag_team', 'red', loopFrame('flag_team', t), 84, T + Z - 4);
    add(B - Z + 16, 'sprite', 'flag_team', 'green', loopFrame('flag_team', t + 0.3), 84, B - Z + 16);
    add(T + Z + 2, 'sprite', 'tree_pine_snow', '', 0, 12, T + Z + 2);
    add(T + Z - 12, 'sprite', 'tree_pine', '', 0, 154, T + Z - 12);
    add(T + 18, 'sprite', 'tree_pine_snow', '', 0, 146, T + 18);
    add(B - 2, 'sprite', 'tree_pine_snow', '', 0, 20, B - 2);
    add(B - 8, 'sprite', 'tree_pine', '', 0, 152, B - 8);
    add(B - 30, 'sprite', 'tree_pine_snow', '', 0, 6, B - 30);
    add(T + 20, 'sprite', 'snow_pile', '', 0, 40, T + 20);
    add(B - 20, 'sprite', 'snow_pile', '', 0, 124, B - 20);
    const ry = scene.fortY('red');
    const gy = scene.fortY('green');
    for (const x of FORT_XS) {
      add(ry, 'sprite', 'fort_front', '', 0, x, ry);
      add(gy, 'sprite', 'fort_back', '', 0, x, gy);
    }
    add(ry - 6, 'sprite', 'ball_stash', '', 0, 58, ry - 6);
    add(gy + 6, 'sprite', 'ball_stash', '', 0, 112, gy + 6);
    const F = Math.round(s.F);
    add(F + 3, 'rope', '', '', 0, 0, F);
    for (const k of s.kids) {
      const y = Math.round(k.y);
      const bob = k.moving && k.state === 'idle' ? Math.floor(t * 8 + k.phase * 8) % 2 : 0;
      add(y, 'kid', KID_NAMES[k.view][k.state], k.team, kidFrame(k, t), k.x, y - bob, k);
    }
    for (const g of s.giants) {
      const tf = giantThrowFrame(g);
      const drop = g.t < 0.2 ? Math.round((1 - g.t / 0.2) * 12) : 0;
      const names = GIANT_NAMES[g.view];
      add(g.y, 'giant', tf < 0 ? names.idle : names.throw, g.team,
        tf < 0 ? loopFrame(names.idle, t + g.x) : tf, g.x, g.y - drop, g);
    }
    if (s.winner) {
      const bob = Math.round(Math.abs(Math.sin(t * 4)) * 2);
      const cy = s.winner === 'red' ? T + Z - 24 : B - Z - 4;
      add(1e6, 'sprite', 'crown', '', 0, 85, cy - bob);
    }
    // insertion sort is plenty for ~40 mostly-sorted items and allocates nothing
    for (let i = 1; i < nDraw; i++) {
      const d = drawables[i];
      let j = i - 1;
      while (j >= 0 && sortFn(drawables[j], d) > 0) {
        drawables[j + 1] = drawables[j];
        j--;
      }
      drawables[j + 1] = d;
    }
  }

  function drawDrawables() {
    for (let i = 0; i < nDraw; i++) {
      const d = drawables[i];
      switch (d.kind) {
        case 'rope':
          ctx.drawImage(ropeCache, 0, d.y - ROPE_ORIGIN);
          break;
        case 'kid':
          drawSprite(ctx, 'shadow_kid', d.x, d.key);
          if (d.ref === s.myKid && myLook) {
            // the owner's kid: equipped cosmetics (pet/back/aura/trim, DESIGN.md §12) + gold
            // marker (bob in sync with the kid). Pets stay ≥8 px from the front line, on their
            // own side, x clamped to [8, 160], and never cross-fade into the actor y-sort.
            const petPos = myLook.pet ? clampPetPos(d.team, d.x, d.y, myLook.pet.offset, s.F) : null;
            drawKidLook(ctx, d.name, d.team, d.frame, d.x, d.y, myLook, s.time, petPos);
            drawYouMarker(ctx, d.name, d.frame, d.x, d.y, myLook, Math.floor(s.time * 3) % 2);
          } else {
            drawSprite(ctx, d.name, d.x, d.y, d.team, d.frame);
          }
          break;
        case 'giant':
          drawSprite(ctx, 'shadow_giant', d.x, d.key);
          drawSprite(ctx, d.name, d.x, d.y, d.team, d.frame);
          break;
        default:
          drawSprite(ctx, d.name, d.x, d.y, d.team, d.frame);
      }
    }
  }

  // ---------- projectiles, FX ----------
  // Owner's snowball trail: FX layer, beneath the balls (1×1, confetti flips to 2×1).
  function drawTrails() {
    for (const q of s.trails) {
      if (!q.active) continue;
      ctx.fillStyle = q.color;
      ctx.fillRect(Math.round(q.x), Math.round(q.y), q.wide ? 2 : 1, 1);
    }
  }

  function drawBalls() {
    for (const b of s.balls) {
      if (!b.active) continue;
      const small = b.kind === 'small';
      drawSprite(ctx, small ? 'shadow_small' : 'shadow_big', b.x, b.y);
      drawSprite(ctx, small ? 'ball_small' : 'ball_big', b.x, b.y - b.z);
    }
  }

  function drawFx() {
    for (const f of s.fx) {
      if (!f.active) continue;
      const spr = SPRITES[f.name];
      drawSprite(ctx, f.name, f.x, f.y, '', Math.min(spr.frames.length - 1, Math.floor(f.t * spr.fps)));
    }
    for (const p of s.particles) {
      if (!p.active) continue;
      ctx.fillStyle = p.color;
      ctx.fillRect(Math.round(p.x), Math.round(p.y), p.w || 1, p.h || 1);
    }
  }

  // ---------- price axis (not shaken) ----------
  function drawSign(name, y, label) {
    drawSprite(ctx, name, AXIS_X, y);
    const tw = miniTextWidth(label);
    ctx.drawImage(
      miniText(label, UI.signText.color),
      AXIS_X + UI.signText.origin[0] + Math.floor((19 - tw) / 2),
      y - SPRITES[name].anchor[1] + UI.signText.origin[1],
    );
  }

  function drawAxis(round) {
    const r = round.state;
    if (r.phase === 'waiting' || !(r.high > r.low)) return;
    if (r.low !== axisLow || r.high !== axisHigh || geomKey() !== axisH) {
      axisLow = r.low;
      axisHigh = r.high;
      axisH = geomKey();
      axis = axisLevels({
        low: r.low, high: r.high, yLow: s.Fmax, yHigh: s.Fmin, height: s.H,
        skipTop: s.top + 4, skipBottom: s.H - s.bot + 12, // no signs hidden under the HUD
      });
    }
    const F = Math.round(s.F);
    ctx.fillStyle = PALETTE.B;
    for (const m of axis) {
      if (Math.abs(m.y - F) < 12) continue; // the current-price sign owns this spot
      ctx.fillRect(AXIS_X - 6, m.y, 6, 1);
      drawSign('marker_sign', m.y, m.label);
    }
    ctx.fillStyle = PALETTE.Y;
    ctx.fillRect(AXIS_X - 6, F, 6, 1);
    drawSign('marker_sign_hi', F, signLabel(r.price));
  }

  // Active time forecasts: dotted line at each entry price (team colour by direction) with a
  // tiny horizon label; skipped when the entry is outside the visible band.
  const FC_LABELS = ['1m', '5m', '15m', '1h', '4h', '1d'];
  const FC_COLORS = { u: '#a6e85c', d: '#d63a4f' };
  let getForecasts = null;
  let myLook = null; // cosmetics look for the owner's kid (null = feature off)
  function drawForecastLines(round) {
    const list = getForecasts?.();
    const r = round.state;
    if (!list || !list.length || r.phase === 'waiting' || !(r.high > r.low)) return;
    const pxPerUsd = (s.Fmax - s.Fmin) / (r.high - r.low);
    let n = 0;
    for (let i = 0; i < list.length; i++) {
      const fc = list[i];
      // candle entries ['c', h, dir, t0, open]: line at the CANDLE OPEN (only once it's known);
      // legacy entries [h, dir, entryPrice, …]: line at the entry price
      const candle = fc[0] === 'c';
      const h = candle ? fc[1] : fc[0];
      const dir = candle ? fc[2] : fc[1];
      const price = candle ? fc[4] : fc[2];
      if (!(price > 0)) continue;
      const y = Math.round(s.Fmin + (r.high - price) * pxPerUsd);
      if (y < s.top + 2 || y > s.bot - 2) continue;
      ctx.fillStyle = FC_COLORS[dir] || PALETTE.B;
      for (let x = (n & 1); x < AXIS_X - 8; x += 3) ctx.fillRect(x, y, 1, 1);
      const label = miniText(FC_LABELS[h] || '', FC_COLORS[dir] || PALETTE.B);
      const ly = y - 7 >= s.top ? y - 7 : y + 2;
      const lx = 1 + n * 16; // stagger labels so equal prices don't hide each other
      ctx.fillStyle = PALETTE.k;
      ctx.fillRect(lx, ly - 1, label.width + 2, 7);
      ctx.drawImage(label, lx + 1, ly);
      n++;
    }
  }

  function drawFlakes(t) {
    const fr = frames('snowflake');
    for (const f of s.flakes) {
      ctx.drawImage(fr[(Math.floor(t * 2 + f.ph) + f.f) % 2], Math.round(f.x) - 1, Math.round(f.y) - 1);
    }
  }

  function draw(round) {
    ensureCaches();
    const t = s.time;
    const { x: ox, y: oy } = s.camera.offset;
    ctx.fillStyle = PALETTE.o;
    ctx.fillRect(0, 0, W, s.H);
    ctx.setTransform(1, 0, 0, 1, ox, oy);
    ctx.drawImage(groundCache, 0, 0);
    ctx.drawImage(trenchCache, 0, Math.round(s.F) - TRENCH_ORIGIN);
    collect(t);
    drawDrawables();
    drawTrails();
    drawBalls();
    drawFx();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    drawAxis(round);
    drawForecastLines(round);
    drawFlakes(t);
  }

  return {
    setSize,
    draw,
    // fn() → array of active forecasts [h, dir, entryPrice, ...] (read each frame, no copies)
    setForecastSource(fn) { getForecasts = fn; },
    setMyLook(look) { myLook = look; },
  };
}
