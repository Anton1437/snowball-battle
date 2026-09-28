// Draws a kid sprite wearing a cosmetics "look" (src/cosmetics.js): palette swaps baked once
// per (sprite, team, equip combination) and cached, hat overlays pinned to HAT_POINTS for the
// exact animation frame, the gold "you" marker, and (v1.08, DESIGN.md §12) back items, auras,
// trims and a pet around the kid. Shared by the field renderer and the profile avatar.
// Draw order (DESIGN.md §12): frost steps (engine, see scene.js) → back-half ring/orbit →
// back item (behind) → glow outline → kid → back item (front) → fringe trim → hat overlays →
// front-half ring/orbit → pet → marker (caller, drawYouMarker).
import {
  SPRITES, PALETTE, frames, drawSprite,
} from './sprites-cache.js?v=461444cd';
import { hatPoint, bodyPoint } from '../cosmetics.js?v=461444cd';

// Cached alpha masks (for the outline aura) keyed by the baked canvas itself.
const maskCache = new WeakMap();
function alphaMaskOf(canvas) {
  let d = maskCache.get(canvas);
  if (!d) {
    d = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    maskCache.set(canvas, d);
  }
  return d;
}

function viewOfSpriteName(name) {
  return name.includes('back') ? 'back' : 'front';
}

// Kid sprite anchored at feet (ax, ay); (x, y) = feet position. `t` (seconds) animates auras,
// back items and the mitten-glow trim; omit it (defaults to 0) for a static preview frame.
// `petPos`, if given, overrides where the pet is drawn (field renderer clamps it to DESIGN
// §12's field-readability rules; the profile/wardrobe preview uses the item's own offset).
export function drawKidLook(ctx, name, team, frame, x, y, look, t = 0, petPos = null) {
  const spr = SPRITES[name];
  const ox = Math.round(x - spr.anchor[0]);
  const oy = Math.round(y - spr.anchor[1]);
  const bp = bodyPoint(name, frame);
  const aura = look?.aura;
  const view = viewOfSpriteName(name);

  const orbit = (front) => {
    if (!aura || !SPRITES[aura.sprite] || (aura.type !== 'ring' && aura.mode !== 'orbit')) return;
    for (let i = 0; i < aura.count; i++) {
      const a = (t * 2 * Math.PI * 1000) / aura.periodMs + (i * 2 * Math.PI) / aura.count;
      if ((Math.sin(a) > 0) !== front) continue;
      const cy = (aura.cyFrom === 'neck' && bp ? oy + bp.neck[1] : y) + (aura.cy || 0);
      drawSprite(ctx, aura.sprite, x + Math.round(Math.cos(a) * aura.rx), cy + Math.round(Math.sin(a) * aura.ry), 'green', Math.floor(t * 4 + i) % 2);
    }
  };
  // frost-steps footprints are spawned by the scene as pooled particles (engine-level, capped);
  // nothing to draw here for that aura type.
  orbit(false);

  const bi = look?.back;
  const vk = view === 'back' ? 'back' : 'front';
  const backSprite = bi?.[vk];
  const drawBack = (layer) => {
    if (!backSprite || bi.layer?.[vk] !== layer || !bp || !SPRITES[backSprite]) return;
    const bs = SPRITES[backSprite];
    ctx.save();
    ctx.beginPath();
    ctx.rect(ox - 20, oy - 20, spr.w + 40, spr.h + 40); // clip so nothing hangs below the feet
    ctx.clip();
    drawSprite(ctx, backSprite, ox + bp.neck[0], oy + bp.neck[1], team, Math.floor(t * (bs.fps || 1)) % bs.frames.length);
    ctx.restore();
  };
  drawBack('behind');

  let overrides = look?.overrides || null;
  let overrideKey = look?.key;
  const trim = look?.trim;
  if (trim?.type === 'swapCycle') {
    const step = Math.floor((t * 1000) / trim.stepMs) % trim.colors.length;
    overrides = { ...(overrides || {}), [trim.char]: trim.colors[step] };
    overrideKey = `${look.key}|tc${step}`;
  }
  const fr = overrides ? frames(name, team, false, overrides, overrideKey) : frames(name, team);
  const kc = fr[frame % fr.length];

  // Glow outline: only from the neck row down, so it never touches the hat (SPEC §5.3, §12).
  if (aura?.type === 'outline' && bp) {
    const d = alphaMaskOf(kc);
    const w = kc.width;
    const h = kc.height;
    const opaque = (xx, yy) => xx >= 0 && yy >= 0 && xx < w && yy < h && d[(yy * w + xx) * 4 + 3];
    ctx.fillStyle = aura.colors[Math.floor((t * 1000) / aura.pulseMs) % 2];
    for (let yy = bp.neck[1]; yy <= h; yy++) {
      for (let xx = -1; xx <= w; xx++) {
        if (!opaque(xx, yy) && (opaque(xx - 1, yy) || opaque(xx + 1, yy) || opaque(xx, yy - 1) || opaque(xx, yy + 1))) {
          ctx.fillRect(ox + xx, oy + yy, 1, 1);
        }
      }
    }
  }

  ctx.drawImage(kc, ox, oy);
  drawBack('front');

  if (trim?.type === 'sprite' && bp && SPRITES[trim.sprite]) {
    const ts = SPRITES[trim.sprite];
    drawSprite(ctx, trim.sprite, ox + bp.tail[0], oy + bp.tail[1], 'green', Math.floor(t * (trim.fps || 1)) % ts.frames.length);
  }

  if (!look) return;
  for (let i = 0; i < look.overlays.length; i++) {
    const ov = look.overlays[i];
    const os = SPRITES[ov.sprite];
    if (os.w === spr.w && os.h === spr.h) {
      // full-size pattern overlay: aligned to the kid sprite, frame-matched when it animates
      const of = frames(ov.sprite, team);
      ctx.drawImage(of[frame % of.length], ox, oy);
      continue;
    }
    const pt = hatPoint(name, frame, ov.at);
    if (pt) drawSprite(ctx, ov.sprite, ox + pt[0], oy + pt[1], team, 0);
  }

  orbit(true);

  if (look.pet && SPRITES[look.pet.sprites?.idle]) {
    const p = look.pet;
    const hopMs = p.hop?.ms || 280;
    const hopping = (t % 3) < hopMs / 1000;
    const ps = hopping ? p.sprites.hop : p.sprites.idle;
    if (SPRITES[ps]) {
      const px = petPos ? petPos.x : x + p.offset[0];
      const py = (petPos ? petPos.y : y + p.offset[1]) - (hopping ? p.hop.px : 0);
      drawSprite(ctx, ps, px, py, 'green', Math.floor(t * 2) % SPRITES[ps].frames.length);
    }
  }
}

// Gold "you" marker (DESIGN.md §11): marker_you anchored [2,3] at (top.x, top.y − 2), or
// top.y − 5 when a crown is worn; bobs 1 px at 2 fps. 5×4 pixel fallback if the sprite is absent.
export function drawYouMarker(ctx, name, frame, x, y, look, bob) {
  const spr = SPRITES[name];
  const ox = Math.round(x - spr.anchor[0]);
  const oy = Math.round(y - spr.anchor[1]);
  const top = hatPoint(name, frame, 'top') || [spr.anchor[0], 0];
  const mx = ox + top[0];
  const my = oy + top[1] - (look?.hasTop ? 5 : 2) - bob;
  if (look?.markerSprite) {
    drawSprite(ctx, look.markerSprite, mx, my, 'green', 0);
    return;
  }
  ctx.fillStyle = PALETTE.k;
  ctx.fillRect(mx - 2, my - 3, 5, 1);
  ctx.fillStyle = PALETTE.Y;
  ctx.fillRect(mx - 2, my - 2, 5, 1);
  ctx.fillRect(mx - 1, my - 1, 3, 1);
  ctx.fillStyle = PALETTE.y;
  ctx.fillRect(mx, my, 1, 1);
}

// Where the marker's top edge sits in sprite-space (for the DOM nickname above it).
export function markerTopY(name, frame, y, look) {
  const spr = SPRITES[name];
  const top = hatPoint(name, frame, 'top') || [spr.anchor[0], 0];
  return Math.round(y - spr.anchor[1]) + top[1] - (look?.hasTop ? 5 : 2) - 3;
}

// Field-readability clamp for the pet (DESIGN.md §12): stays on the owner's side, at least
// 8 px from the front line, x clamped to [8, 160]. `feetX/feetY` is the kid's feet position.
export function clampPetPos(team, feetX, feetY, offset, F) {
  let py = feetY + offset[1];
  py = team === 'red' ? Math.min(py, F - 8) : Math.max(py, F + 8);
  const px = Math.max(8, Math.min(160, feetX + offset[0]));
  return { x: px, y: py };
}
