// Screen shake (DESIGN.md §7): integer offsets re-rolled every frame within ±a, a decaying
// linearly over the duration. Overlapping shakes keep the strongest remaining amplitude.

export function createCamera({ reducedMotion = false } = {}) {
  let amp = 0;
  let dur = 0;
  let t = 0;
  const offset = { x: 0, y: 0 };

  return {
    offset,
    // amplitude in logical px, duration in seconds
    shake(a, seconds) {
      if (reducedMotion) return; // prefers-reduced-motion: no shake
      const remaining = dur > 0 ? amp * (1 - t / dur) : 0;
      if (a >= remaining) {
        amp = a;
        dur = seconds;
        t = 0;
      }
    },
    update(dt) {
      if (t < dur) t += dt;
      const a = t < dur ? Math.ceil(amp * (1 - t / dur)) : 0;
      offset.x = a ? Math.round((Math.random() * 2 - 1) * a) : 0;
      offset.y = a ? Math.round((Math.random() * 2 - 1) * a) : 0;
    },
  };
}
