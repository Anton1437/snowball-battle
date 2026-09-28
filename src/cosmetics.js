// v1.07 "My kid + wardrobe": cosmetic catalog, unlock rules and the per-team "look" used by
// the renderer and the profile avatar. Cosmetics never change the hat silhouette, its main
// colour H or the white pompom/brim (gamification/SPEC.md §5.3).
//
// Art lives in src/sprites.js (designer): HAT_POINTS, COSMETIC_SWAPS, TRAILS, FRAMES and the
// cos_* / marker_you sprites. Everything here degrades gracefully while any of it is missing:
// overlays without a sprite or hat point are skipped, swaps/trails/frames fall back to palette
// colours below.
import * as ART from './sprites.js?v=a191950d';
import { levelOf } from './progress/achievements.js?v=a191950d';

export const SLOTS = ['hat', 'scarf', 'mitt', 'trail', 'frame'];
export const SLOT_KEY = { hat: 'h', scarf: 's', mitt: 'm', trail: 't', frame: 'f' }; // keys in p.eq

// Catalog order is append-only: indexes are used by the seen/notified bitmasks in storage.
export const ITEMS = [
  { id: 'pin_star', slot: 'hat', unlock: { level: 3 }, overlay: { sprite: 'cos_pin_star', at: 'pin' } },
  { id: 'pin_cockade', slot: 'hat', unlock: { level: 5 }, overlay: { sprite: 'cos_pin_cockade', at: 'pin' } },
  { id: 'snow_pattern', slot: 'hat', unlock: { ach: 'week' }, overlay: { sprite: { front: 'cos_snow_front', back: 'cos_snow_back' }, at: 'pin' } },
  { id: 'pin_whale', slot: 'hat', unlock: { ach: 'whale_survivor' }, overlay: { sprite: 'cos_pin_whale', at: 'pin' } },
  { id: 'hat_trim_gold', slot: 'hat', unlock: { ach: 'hot5' }, swap: true },
  { id: 'crown_top', slot: 'hat', unlock: { ach: 'full_spectrum' }, overlay: { sprite: 'cos_crown_top', at: 'top' } },
  { id: 'scarf_night', slot: 'scarf', unlock: { level: 2 }, swap: true },
  { id: 'scarf_frost', slot: 'scarf', unlock: { ach: 'month' }, swap: true },
  { id: 'scarf_gold', slot: 'scarf', unlock: { level: 10 }, swap: true },
  { id: 'mitt_pink', slot: 'mitt', unlock: { level: 4 }, swap: true },
  { id: 'mitt_blue', slot: 'mitt', unlock: { ach: 'scalper' }, swap: true },
  { id: 'mitt_white', slot: 'mitt', unlock: { ach: 'swing' }, swap: true },
  { id: 'trail_sparks', slot: 'trail', unlock: { ach: 'first_breakout' } },
  { id: 'trail_flakes', slot: 'trail', unlock: { level: 6 } },
  { id: 'trail_confetti', slot: 'trail', unlock: { ach: 'day_prophet' } },
  { id: 'frame_silver', slot: 'frame', unlock: { level: 5 } },
  { id: 'frame_gold', slot: 'frame', unlock: { level: 10 } },
  { id: 'frame_aurora', slot: 'frame', unlock: { ach: 'oracle10' } },
];
export const ITEM_INDEX = Object.fromEntries(ITEMS.map((it, i) => [it.id, i]));
export const byId = Object.fromEntries(ITEMS.map((it) => [it.id, it]));

// ---------- fallbacks (palette colours) until the designer's data lands ----------
const P = ART.PALETTE;
const FALLBACK_SWAPS = {
  hat_trim_gold: { h: P.y },   // hat shade → gold trim (H and the pompom untouched)
  scarf_night: { s: P.K },     // scarf shade only; S stays the team colour
  scarf_frost: { s: P.b },
  scarf_gold: { s: P.y },
  mitt_white: { y: P.w },
  mitt_pink: { y: P.p },
  mitt_blue: { y: P.j },
};
const FALLBACK_TRAILS = {
  trail_sparks: [P.Y, P.y, P.w],
  trail_flakes: [P.w, P.b, P.w],
  trail_confetti: ['#a6e85c', '#d63a4f', P.Y, '#7fb8ff'],
};
const FALLBACK_FRAMES = {
  frame_silver: ['#bfd2ea', '#8fa7cf'],
  frame_gold: ['#ffe27a', '#f5b83d'],
  frame_aurora: ['#7fb8ff', '#a6e85c'],
};

const pickTeam = (v, team) => (v && typeof v === 'object' && !Array.isArray(v) && (v.green || v.red) ? v[team] || v.green : v);

function swapFor(id, team) {
  const v = pickTeam(ART.COSMETIC_SWAPS?.[id], team);
  return v && typeof v === 'object' ? v : FALLBACK_SWAPS[id] || null;
}

function colorsOf(v) {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') return [v];
  if (v && Array.isArray(v.colors)) return v.colors;
  if (v && typeof v.color === 'string') return [v.color, v.color2 || v.color];
  return null;
}

export const trailColors = (id) => (id ? colorsOf(ART.TRAILS?.[id]) || FALLBACK_TRAILS[id] || null : null);
export const frameColors = (id) => (id ? colorsOf(ART.FRAMES?.[id]) || FALLBACK_FRAMES[id] || null : null);

// ---------- unlocks ----------
export function isUnlocked(item, p) {
  if (item.unlock.level) return levelOf(p.xp).level >= item.unlock.level;
  return p.a?.[item.unlock.ach] != null;
}

export const unlockedMask = (p) => ITEMS.reduce((m, it, i) => (isUnlocked(it, p) ? m | (1 << i) : m), 0);

// ---------- look: everything the renderer needs for one team, rebuilt only on equip change ----------
export const viewOf = (team) => (team === 'red' ? 'front' : 'back');

// eq: { h, s, m, t, f } item ids (absent = none). Only unlocked items are applied.
export function buildLook(eq, team, p) {
  const ids = [];
  let overrides = null;
  const overlays = [];
  for (const slot of SLOTS) {
    const it = byId[eq?.[SLOT_KEY[slot]]];
    if (!it || it.slot !== slot || (p && !isUnlocked(it, p))) continue;
    ids.push(it.id);
    if (it.swap) {
      const sw = swapFor(it.id, team);
      if (sw) overrides = { ...(overrides || {}), ...sw };
    }
    if (it.overlay) {
      const spr = typeof it.overlay.sprite === 'string' ? it.overlay.sprite : it.overlay.sprite[viewOf(team)];
      if (ART.SPRITES[spr]) overlays.push({ sprite: spr, at: it.overlay.at });
    }
  }
  const trailId = byId[eq?.t] && ids.includes(eq.t) ? eq.t : null;
  const frameId = byId[eq?.f] && ids.includes(eq.f) ? eq.f : null;
  return {
    team,
    view: viewOf(team),
    key: `${team}:${ids.join('+')}`,
    overrides,
    overlays,
    trailId,
    trail: trailColors(trailId),
    frame: frameColors(frameId),
    markerSprite: ART.SPRITES.marker_you ? 'marker_you' : null,
    hasTop: overlays.some((o) => o.at === 'top'),
  };
}

// Hat attachment point for a kid sprite frame: HAT_POINTS[sprite][frame] = { pin, top }.
export function hatPoint(spriteName, frame, at) {
  const pts = ART.HAT_POINTS?.[spriteName];
  if (!pts) return null;
  const f = pts[frame] || pts[0];
  return f?.[at] || null;
}

export const artStatus = () => ({
  HAT_POINTS: !!ART.HAT_POINTS,
  COSMETIC_SWAPS: !!ART.COSMETIC_SWAPS,
  TRAILS: !!ART.TRAILS,
  FRAMES: !!ART.FRAMES,
  marker_you: !!ART.SPRITES.marker_you,
  overlays: ['cos_pin_star', 'cos_pin_whale', 'cos_pin_cockade', 'cos_crown_top', 'cos_snow_front', 'cos_snow_back']
    .filter((n) => !ART.SPRITES[n]),
});
