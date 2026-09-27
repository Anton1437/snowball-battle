// Bakes sprite data (src/sprites.js) into cached offscreen canvases, one per (sprite, team, frame).
// Team-swappable chars (H h S s) are replaced by TEAM_COLORS[team]; sprites without them are baked once.
import { PALETTE, TEAM_COLORS, SPRITES, UI } from '../sprites.js?v=c25edd2d';

const TEAM_RE = /[HhSs]/;
const cache = new Map();
const teamAware = new Map();

function hexToRgb(hex) {
  return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
}

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

function usesTeam(name) {
  if (!teamAware.has(name)) teamAware.set(name, SPRITES[name].frames.some((f) => f.some((r) => TEAM_RE.test(r))));
  return teamAware.get(name);
}

// locked (DESIGN.md §10): every opaque pixel except the `k` outline becomes UI.achLocked.
function bake(name, team, locked = false) {
  const s = SPRITES[name];
  if (!s) throw new Error(`[sprites] missing sprite "${name}"`);
  const pal = { ...PALETTE, ...(TEAM_COLORS[team] || TEAM_COLORS.green) };
  const rgb = {};
  const lockedRgb = hexToRgb(UI.achLocked || '#5d6f9e');
  for (const [ch, hex] of Object.entries(pal)) rgb[ch] = !hex ? null : locked && ch !== 'k' ? lockedRgb : hexToRgb(hex);
  return s.frames.map((rows, fi) => {
    if (rows.length !== s.h) throw new Error(`[sprites] ${name} f${fi}: ${rows.length} rows, expected ${s.h}`);
    const c = makeCanvas(s.w, s.h);
    const g = c.getContext('2d');
    const img = g.createImageData(s.w, s.h);
    rows.forEach((row, y) => {
      if (row.length !== s.w) throw new Error(`[sprites] ${name} f${fi} row ${y}: length ${row.length}, expected ${s.w}`);
      for (let x = 0; x < s.w; x++) {
        const col = rgb[row[x]];
        if (col === undefined) throw new Error(`[sprites] ${name}: unknown char "${row[x]}"`);
        if (!col) continue;
        const o = (y * s.w + x) * 4;
        img.data[o] = col[0];
        img.data[o + 1] = col[1];
        img.data[o + 2] = col[2];
        img.data[o + 3] = 255;
      }
    });
    g.putImageData(img, 0, 0);
    return c;
  });
}

// Returns the baked frame canvases for a sprite (team ignored for team-independent sprites).
export function frames(name, team = 'green', locked = false) {
  const key = `${usesTeam(name) ? `${name}|${team}` : name}${locked ? '|locked' : ''}`;
  let f = cache.get(key);
  if (!f) {
    f = bake(name, team, locked);
    cache.set(key, f);
  }
  return f;
}

export const spriteInfo = (name) => SPRITES[name];

// Draw frame `frame` of sprite at anchor point (x, y), integer-snapped.
export function drawSprite(ctx, name, x, y, team, frame = 0) {
  const s = SPRITES[name];
  const f = frames(name, team);
  ctx.drawImage(f[frame % f.length], Math.round(x - s.anchor[0]), Math.round(y - s.anchor[1]));
}

// Looping frame index at time t (seconds) using the sprite's fps.
export function loopFrame(name, t) {
  const s = SPRITES[name];
  return Math.floor(t * (s.fps || 1)) % s.frames.length;
}

// Bake everything up front so the first big event doesn't hitch.
export function preloadAll() {
  for (const name of Object.keys(SPRITES)) {
    if (usesTeam(name)) {
      frames(name, 'green');
      frames(name, 'red');
    } else {
      frames(name);
    }
  }
}

// PNG data URL of a sprite frame scaled by an integer factor (for DOM icons / favicon).
const urlCache = new Map();
export function spriteDataUrl(name, team = 'green', scale = 1, frame = 0, locked = false) {
  const key = `${name}|${team}|${scale}|${frame}|${locked}`;
  if (urlCache.has(key)) return urlCache.get(key);
  const s = SPRITES[name];
  const c = makeCanvas(s.w * scale, s.h * scale);
  const g = c.getContext('2d');
  g.imageSmoothingEnabled = false;
  g.drawImage(frames(name, team, locked)[frame], 0, 0, s.w * scale, s.h * scale);
  const url = c.toDataURL('image/png');
  urlCache.set(key, url);
  return url;
}

// Several sprites layered in one w×h box (e.g. the hot5 icon: ball_big + ach_flame).
// parts: [{ name, team, x, y }] with (x, y) = top-left in box pixels.
export function compositeDataUrl(key, parts, w, h, scale = 1, locked = false) {
  const ck = `composite|${key}|${scale}|${locked}`;
  if (urlCache.has(ck)) return urlCache.get(ck);
  const c = makeCanvas(w * scale, h * scale);
  const g = c.getContext('2d');
  g.imageSmoothingEnabled = false;
  for (const part of parts) {
    const s = SPRITES[part.name];
    g.drawImage(frames(part.name, part.team || 'green', locked)[0], part.x * scale, part.y * scale, s.w * scale, s.h * scale);
  }
  const url = c.toDataURL('image/png');
  urlCache.set(ck, url);
  return url;
}

// ---------- 3×5 mini font (price-axis labels) ----------
const textCache = new Map();
// Engine-side 3×5 glyphs missing from UI.miniFont (forecast horizon labels on the axis).
const EXTRA_GLYPHS = {
  m: ['...', '###', '###', '#.#', '#.#'],
  h: ['#..', '#..', '###', '#.#', '#.#'],
};
export function miniTextWidth(str) {
  return str.length ? str.length * UI.miniFont.advance - 1 : 0;
}

// Cached canvas with `str` rendered in UI.miniFont.
export function miniText(str, color) {
  const key = `${color}|${str}`;
  let c = textCache.get(key);
  if (c) return c;
  if (textCache.size > 300) textCache.clear();
  const f = UI.miniFont;
  c = makeCanvas(Math.max(1, miniTextWidth(str)), f.h);
  const g = c.getContext('2d');
  g.fillStyle = color;
  for (let i = 0; i < str.length; i++) {
    const glyph = f.glyphs[str[i]] || EXTRA_GLYPHS[str[i]];
    if (!glyph) continue;
    for (let gy = 0; gy < f.h; gy++) {
      for (let gx = 0; gx < f.w; gx++) if (glyph[gy][gx] === '#') g.fillRect(i * f.advance + gx, gy, 1, 1);
    }
  }
  textCache.set(key, c);
  return c;
}

export { makeCanvas, PALETTE, TEAM_COLORS, SPRITES, UI };
