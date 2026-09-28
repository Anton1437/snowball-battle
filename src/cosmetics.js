// v1.07 "My kid + wardrobe" (+ v1.08 cosmetics v2, DESIGN.md §12): cosmetic catalog, unlock
// rules and the per-team "look" used by the renderer and the profile avatar. Cosmetics never
// change the hat silhouette, its main colour H or the white pompom/brim (SPEC §5.3).
//
// Art lives in src/sprites.js (designer): HAT_POINTS, BODY_POINTS, COSMETIC_SWAPS, TRAILS,
// FRAMES, VIEW_OVERLAYS, PETS, BACK_ITEMS, AURAS, TRIMS, LOOKS and the cos_* / marker_you /
// pet_* / back_* / fx_* sprites. Everything here degrades gracefully while any of it is
// missing: overlays without a sprite or hat point are skipped, swaps/trails/frames fall back
// to palette colours below.
import * as ART from './sprites.js?v=43edfa8d';
import { levelOf } from './progress/achievements.js?v=43edfa8d';

export const SLOTS = ['hat', 'scarf', 'mitt', 'pet', 'back', 'aura', 'trim', 'trail', 'frame'];
// keys in p.eq — short, and distinct from every other top-level profile field.
export const SLOT_KEY = {
  hat: 'h', scarf: 's', mitt: 'm', pet: 'p', back: 'k', aura: 'u', trim: 'x', trail: 't', frame: 'f',
};

// Catalog order is append-only: indexes are used by the seen/notified bitmasks in storage.
export const ITEMS = [
  { id: 'pin_star', slot: 'hat', unlock: { level: 3 }, overlay: { sprite: 'cos_pin_star', at: 'pin' } },
  { id: 'pin_cockade', slot: 'hat', unlock: { level: 5 }, overlay: { sprite: 'cos_pin_cockade', at: 'pin' } },
  {
    id: 'snow_pattern',
    slot: 'hat',
    unlock: { ach: 'week' },
    overlay: { sprite: { front: 'cos_snow_front', back: 'cos_snow_back', beanie: 'cos_snow_beanie' }, at: 'pin' },
  },
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
  // ---------- v1.08 cosmetics v2 (DESIGN.md §12) ----------
  { id: 'pet_bullfinch', slot: 'pet', unlock: { ach: 'early_bird' } },
  { id: 'pet_penguin', slot: 'pet', unlock: { level: 8 } },
  { id: 'pet_fox', slot: 'pet', unlock: { level: 12 } },
  { id: 'pet_snowman', slot: 'pet', unlock: { ach: 'summoner' } },
  { id: 'back_scarf_long', slot: 'back', unlock: { level: 3 } },
  { id: 'back_backpack', slot: 'back', unlock: { level: 6 } },
  { id: 'back_sled', slot: 'back', unlock: { ach: 'week' } },
  { id: 'back_cape_navy', slot: 'back', unlock: { level: 9 } },
  { id: 'back_cape_frost', slot: 'back', unlock: { ach: 'month' } },
  { id: 'back_cape_gold', slot: 'back', unlock: { premium: true } },
  // aura/pet/back/trim ids match the designer's AURAS/PETS/BACK_ITEMS/TRIMS keys 1:1 — LOOKS
  // (below) reference them the same way, so a look's items resolve without a translation table.
  // "footprints" (unlock table, §12) = aura_frost_steps; "frost glow" = aura_glow_frost;
  // "gold glow" = aura_glow_gold.
  { id: 'aura_frost_steps', slot: 'aura', unlock: { level: 4 } },
  { id: 'aura_sparkle_ring', slot: 'aura', unlock: { ach: 'avalanche' } },
  { id: 'aura_glow_frost', slot: 'aura', unlock: { level: 15 } },
  { id: 'aura_orbit_flakes', slot: 'aura', unlock: { ach: 'oracle10' } },
  { id: 'aura_glow_gold', slot: 'aura', unlock: { premium: true } },
  { id: 'trim_fringe_gold', slot: 'trim', unlock: { premium: true } },
  { id: 'trim_mitt_glow', slot: 'trim', unlock: { ach: 'full_spectrum' } },
  { id: 'pin_btc', slot: 'hat', unlock: { premium: true }, overlay: { sprite: 'cos_pin_btc', at: 'pin' } },
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

// ---------- looks (DESIGN.md §12): curated bundles, equipped with one tap ----------
// LOOKS[id].items.hat is a *sprite name* (cos_pin_whale, cos_crown_top, cos_pin_btc), everything
// else is already a catalog id (pet/back/aura/trim ids, swap ids, frame/trail ids).
const spriteToHatId = (() => {
  const m = {};
  for (const it of ITEMS) {
    if (it.slot !== 'hat' || !it.overlay) continue;
    const spr = it.overlay.sprite;
    if (typeof spr === 'string') m[spr] = it.id;
    else if (spr) for (const v of Object.values(spr)) m[v] = it.id;
  }
  return m;
})();

// Every catalog id a look bundle references (hat resolved from its sprite name).
export function lookItemIds(look) {
  const ids = [];
  if (look.items.hat) {
    const id = spriteToHatId[look.items.hat];
    if (id) ids.push(id);
  }
  for (const key of ['pet', 'back', 'aura', 'trim', 'frame', 'trail']) {
    if (look.items[key]) ids.push(look.items[key]);
  }
  if (Array.isArray(look.items.swaps)) ids.push(...look.items.swaps);
  return ids;
}

export const LOOK_IDS = Object.keys(ART.LOOKS || {});

// Free look unlock strings: "lv:5" or "ach:whale_survivor".
export function isLookUnlocked(id, p) {
  const look = ART.LOOKS?.[id];
  if (!look || look.tier !== 'free' || !look.unlock) return false;
  const [kind, val] = String(look.unlock).split(':');
  if (kind === 'lv') return levelOf(p.xp).level >= Number(val);
  if (kind === 'ach') return p.a?.[val] != null;
  return false;
}

export function lookReq(id) {
  const look = ART.LOOKS?.[id];
  if (!look?.unlock) return null;
  const [kind, val] = String(look.unlock).split(':');
  return kind === 'lv' ? { level: Number(val) } : { ach: val };
}

// An item is also unlocked when it's granted by an unlocked free look that includes it
// (DESIGN.md §12: "when a free look unlocks, it grants its items").
function grantedByLook(itemId, p) {
  if (!p) return false;
  for (const id of LOOK_IDS) {
    const look = ART.LOOKS[id];
    if (look.tier !== 'free' || !isLookUnlocked(id, p)) continue;
    if (lookItemIds(look).includes(itemId)) return true;
  }
  return false;
}

// ---------- unlocks ----------
export function isUnlocked(item, p) {
  if (!item.unlock.premium) {
    if (item.unlock.level && levelOf(p.xp).level >= item.unlock.level) return true;
    if (item.unlock.ach && p.a?.[item.unlock.ach] != null) return true;
  }
  return grantedByLook(item.id, p);
}

// A BigInt bitmask (ITEMS is already past 32 entries, so a plain JS number would wrap and
// collide bits) — stored in p.seen as a decimal string (see store.js's schema note).
export const unlockedMask = (p) => ITEMS.reduce((m, it, i) => (isUnlocked(it, p) ? m | (1n << BigInt(i)) : m), 0n);

// ---------- look: everything the renderer needs for one team, rebuilt only on equip change ----------
export const viewOf = (team) => (team === 'red' ? 'front' : 'back');
// UI-only (profile/wardrobe/cards): green faces the viewer in the beanie (DESIGN.md §11 v1.08).
// Never used on the battlefield.
export const avatarViewOf = (team) => (team === 'red' ? 'front' : 'beanie');
export const avatarSpriteName = (team, anim) => (team === 'red' ? `kid_front_${anim}` : `kid_front_beanie_${anim}`);

// eq: { h, s, m, p, k, u, x, t, f } item ids (absent = none). Only unlocked items are applied,
// unless `extraIds` (a Set) explicitly allows one through — used for premium try-on previews.
export function buildLook(eq, team, p, { view: viewOverride, extraIds } = {}) {
  const view = viewOverride || viewOf(team);
  const ids = [];
  let overrides = null;
  const overlays = [];
  let pet = null;
  let back = null;
  let aura = null;
  let trim = null;
  for (const slot of SLOTS) {
    const it = byId[eq?.[SLOT_KEY[slot]]];
    if (!it || it.slot !== slot) continue;
    if (p && !isUnlocked(it, p) && !extraIds?.has(it.id)) continue;
    ids.push(it.id);
    if (it.swap) {
      const sw = swapFor(it.id, team);
      if (sw) overrides = { ...(overrides || {}), ...sw };
    }
    if (it.overlay) {
      const spr = typeof it.overlay.sprite === 'string' ? it.overlay.sprite : it.overlay.sprite[view];
      if (spr && ART.SPRITES[spr]) overlays.push({ sprite: spr, at: it.overlay.at });
    }
    if (slot === 'pet' && ART.PETS?.[it.id]) pet = { id: it.id, ...ART.PETS[it.id] };
    if (slot === 'back' && ART.BACK_ITEMS?.[it.id]) back = { id: it.id, ...ART.BACK_ITEMS[it.id] };
    if (slot === 'aura' && ART.AURAS?.[it.id]) aura = { id: it.id, ...ART.AURAS[it.id] };
    if (slot === 'trim' && ART.TRIMS?.[it.id]) trim = { id: it.id, ...ART.TRIMS[it.id] };
  }
  const trailId = byId[eq?.t] && ids.includes(eq.t) ? eq.t : null;
  const frameId = byId[eq?.f] && ids.includes(eq.f) ? eq.f : null;
  return {
    team,
    view,
    key: `${team}:${view}:${ids.join('+')}`,
    overrides,
    overlays,
    pet,
    back,
    aura,
    trim,
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

// Body attachment point (v1.08): BODY_POINTS[sprite][frame] = { neck, tail }.
export function bodyPoint(spriteName, frame) {
  const pts = ART.BODY_POINTS?.[spriteName];
  if (!pts) return null;
  return pts[frame] || pts[0] || null;
}

export const artStatus = () => ({
  HAT_POINTS: !!ART.HAT_POINTS,
  BODY_POINTS: !!ART.BODY_POINTS,
  COSMETIC_SWAPS: !!ART.COSMETIC_SWAPS,
  TRAILS: !!ART.TRAILS,
  FRAMES: !!ART.FRAMES,
  PETS: !!ART.PETS,
  BACK_ITEMS: !!ART.BACK_ITEMS,
  AURAS: !!ART.AURAS,
  TRIMS: !!ART.TRIMS,
  LOOKS: !!ART.LOOKS,
  marker_you: !!ART.SPRITES.marker_you,
  overlays: ['cos_pin_star', 'cos_pin_whale', 'cos_pin_cockade', 'cos_crown_top', 'cos_snow_front', 'cos_snow_back', 'cos_snow_beanie', 'cos_pin_btc']
    .filter((n) => !ART.SPRITES[n]),
});
