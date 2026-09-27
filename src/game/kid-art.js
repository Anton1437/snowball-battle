// Draws a kid sprite wearing a cosmetics "look" (src/cosmetics.js): palette swaps baked once
// per (sprite, team, equip combination) and cached, hat overlays pinned to HAT_POINTS for the
// exact animation frame, and the gold "you" marker. Shared by the field renderer and the
// profile avatar. No allocations per call.
import { SPRITES, PALETTE, frames, drawSprite } from './sprites-cache.js?v=6ee7c4dd';
import { hatPoint } from '../cosmetics.js?v=6ee7c4dd';

// Kid sprite anchored at feet (ax, ay); (x, y) = feet position.
export function drawKidLook(ctx, name, team, frame, x, y, look) {
  const spr = SPRITES[name];
  const ox = Math.round(x - spr.anchor[0]);
  const oy = Math.round(y - spr.anchor[1]);
  const f = look?.overrides ? frames(name, team, false, look.overrides, look.key) : frames(name, team);
  ctx.drawImage(f[frame % f.length], ox, oy);
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
