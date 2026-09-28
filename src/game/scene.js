// Scene simulation (no drawing): kids, forts, giants, balls, FX, particles, snowflakes.
// Geometry and timings follow design/DESIGN.md §4, §5 and §7. The renderer reads this state.
//
// Teams: 'red' = sellers, TOP, front view (trapper hat). 'green' = buyers, BOTTOM, back view (beanie).
// Market side → team: 'buy' → green, 'sell' → red.
import { SPRITES, TEAM_COLORS, PALETTE } from '../sprites.js?v=461444cd';
import { createCamera } from './camera.js?v=461444cd';

export const W = 192;
export const AXIS_X = 168;
export const FIELD_W = AXIS_X;          // actors live in x ∈ [0, 167]

const KID_ROWS = [
  // row, x (red), x (green)
  ['front', 26, 26], ['front', 84, 84], ['front', 142, 142],
  ['back', 56, 56], ['back', 86, 82], ['back', 112, 112],
];
const FORT_XS = [28, 84, 140];
const GIANT_XS = [36, 84, 132];
const RELEASE = {                       // ball release offsets from the anchor: ground dx, height z
  front: { dx: 1, z: 6 },
  back: { dx: 5, z: 13 },
  giant: { dx: 14, z: 20 },
};
const SMALL = { speed: 95, peakK: 0.22, peakMin: 6, peakMax: 24, hitR: 7 };
const BIG = { speed: 70, peakK: 0.35, peakMin: 14, peakMax: 40, hitR: 22, duckR: 44 };
const GIANT_T = { dropEnd: 0.2, windup: 1.1, release: 1.5, follow: 1.65, followEnd: 1.95, vanish: 3.2 };
const MAX_BALLS = 48;
const TRAIL_MAX_PER_BALL = 24;
// per-trail particle motion (DESIGN.md §11): life s, gravity px/s², fall px/s, wobble
const TRAIL_KIND = {
  trail_sparks: { life: 0.25, gravity: 30, fall: 0, wobble: 0, confetti: false },
  trail_flakes: { life: 0.4, gravity: 0, fall: 6, wobble: 4, confetti: false },
  trail_confetti: { life: 0.3, gravity: 0, fall: 12, wobble: 0, confetti: true },
};
const MAX_FX = 64;

const rand = (a, b) => a + Math.random() * (b - a);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const teamOf = (side) => (side === 'buy' ? 'green' : 'red');
const enemyOf = (team) => (team === 'green' ? 'red' : 'green');
const viewOf = (team) => (team === 'red' ? 'front' : 'back');

function pool(n, make) {
  const arr = [];
  for (let i = 0; i < n; i++) arr.push(make());
  return arr;
}

export function createScene({ reducedMotion = false, hooks = {} } = {}) {
  const camera = createCamera({ reducedMotion });
  const maxParticles = reducedMotion ? 40 : 160;
  const flakeCount = reducedMotion ? 12 : 30;

  const s = {
    H: 320, Z: 45, Fmin: 55, Fmax: 265, F: 160, borderT: 0.5,
    // Visible field band [top, bot] between the DOM HUD overlays (logical px). All field
    // geometry — end zones, flags, rows, giant spawns — lives inside it (DESIGN §4 with y
    // measured from `top` and to `bot` instead of 0 and H).
    top: 0, bot: 320,
    // Each army's eased anchor: follows F, but is hard-clamped to its own side of the line,
    // so forts and kids (both placed from it) never cross. red ≤ F ≤ green.
    anchor: { red: 160, green: 160 },
    seed: 1, wob: new Int8Array(FIELD_W),
    time: 0,
    winner: null,
    kids: [],
    giants: [],
    balls: pool(MAX_BALLS, () => ({ active: false })),
    fx: pool(MAX_FX, () => ({ active: false })),
    particles: pool(maxParticles, () => ({ active: false })),
    flakes: [],
    camera,
    pressure: 0,
    myKid: null,   // the owner's kid (v1.07)
    myTrail: null, // { kind, colors } equipped trail for the owner's throws
    myAuraSteps: null, // v1.08: { color, everyPx, lifeMs, max, dist } for aura_frost_steps
    trails: pool(72, () => ({ active: false })), // 3 balls × 24
  };

  const acc = { green: 0, red: 0 };          // throw demand accumulators
  const pendingBig = { green: 0, red: 0 };   // queued big-ball throws
  let lineRefF = s.F;
  let lineRefT = 0;
  let confettiUntil = 0;

  // ---------- geometry (DESIGN.md §4, relative to the visible band) ----------
  const rowY = (team, row) => {
    const a = s.anchor[team];
    if (team === 'red') return row === 'front' ? Math.max(s.top + 30, a - 21) : Math.max(s.top + 18, a - 44);
    return row === 'front' ? Math.min(s.bot - 20, a + 33) : Math.min(s.bot - 3, a + 56);
  };
  const fortY = (team) => (team === 'red'
    ? Math.max(s.top + 34, Math.round(s.anchor.red - 14))
    : Math.min(s.bot - 23, Math.round(s.anchor.green + 24)));
  // red giant spawn keeps room for its 40 px body + 12 px drop-in below the top HUD
  const giantY = (team) => (team === 'red'
    ? Math.max(s.top + 52, Math.round(s.anchor.red - 62))
    : Math.min(s.bot - 2, Math.round(s.anchor.green + 84)));

  function applyGeometry() {
    const band = s.bot - s.top;
    s.Z = Math.round(0.14 * band);
    s.Fmin = s.top + s.Z + 10;
    s.Fmax = s.bot - s.Z - 10;
    s.F = s.Fmin + s.borderT * (s.Fmax - s.Fmin);
    s.anchor.red = s.F;
    s.anchor.green = s.F;
    lineRefF = s.F;
    for (const k of s.kids) k.y = rowY(k.team, k.row);
  }

  function makeWobble() {
    s.seed = 1 + Math.floor(Math.random() * 1000);
    const seed = s.seed;
    for (let x = 0; x < FIELD_W; x++) {
      const v = 0.7 * Math.sin(0.31 * x + seed) + 0.8 * Math.sin(0.11 * x + 2 * seed);
      s.wob[x] = clamp(Math.round(v), -1, 1);
    }
  }

  // H: logical canvas height; insetTop/insetBottom: logical px hidden under HUD overlays.
  function resize(H, insetTop = 0, insetBottom = 0) {
    s.H = H;
    s.top = Math.max(0, Math.round(insetTop));
    s.bot = Math.min(H, Math.round(H - insetBottom));
    if (!s.kids.length) initActors();
    applyGeometry();
    for (const f of s.flakes) f.y = Math.random() * H;
  }

  function initActors() {
    for (const team of ['red', 'green']) {
      for (const [row, xr, xg] of KID_ROWS) {
        s.kids.push({
          team, row, view: viewOf(team),
          x: team === 'red' ? xr : xg, y: 0,
          state: 'idle', t: Math.random() * 2, dur: rand(0.5, 3), phase: Math.random(),
          moving: false, big: false, pushAcc: 0,
        });
      }
    }
    for (let i = 0; i < flakeCount; i++) {
      s.flakes.push({ x: Math.random() * W, y: Math.random() * s.H, v: rand(6, 14), ph: Math.random() * 6.28, f: Math.random() < 0.3 ? 1 : 0 });
    }
  }

  // ---------- spawning ----------
  function spawnFx(name, x, y) {
    const f = s.fx.find((o) => !o.active);
    if (!f) return;
    f.active = true;
    f.name = name;
    f.x = Math.round(x);
    f.y = Math.round(y);
    f.t = 0;
    f.len = SPRITES[name].frames.length / (SPRITES[name].fps || 1);
  }

  function spawnParticle(x, y, vx, vy, life, color, opts = null) {
    const p = s.particles.find((o) => !o.active);
    if (!p) return;
    p.active = true;
    p.x = x; p.y = y; p.vx = vx; p.vy = vy; p.life = life; p.age = 0; p.color = color;
    p.tag = opts?.tag || '';
    p.static = !!opts?.static;
    p.w = opts?.w || 1;
    p.h = opts?.h || 1;
  }

  // aura_frost_steps (DESIGN.md §12): a footprint every few px the owner's kid is pushed,
  // lasting ~1.2 s, capped at a handful on screen — pooled off the shared particle list.
  function maybeSpawnFootprint(dyAbs) {
    const st = s.myAuraSteps;
    if (!st) return;
    st.dist += dyAbs;
    if (st.dist < st.everyPx) return;
    st.dist = 0;
    let live = 0;
    for (const p of s.particles) if (p.active && p.tag === 'step') live++;
    if (live >= st.max) return;
    spawnParticle(s.myKid.x, s.myKid.y, 0, 0, st.lifeMs / 1000, st.color, { tag: 'step', static: true, w: 2, h: 2 });
  }

  function pickTargetKid(team) {
    // reservoir-sample a random enemy kid (no allocations)
    let pick = null;
    let n = 0;
    for (const k of s.kids) {
      if (k.team === team) continue;
      n++;
      if (Math.random() * n < 1) pick = k;
    }
    return pick;
  }

  function spawnBall(team, x0, y0, z0, kind) {
    const b = s.balls.find((o) => !o.active);
    if (!b) return;
    const spec = kind === 'small' ? SMALL : BIG;
    const enemy = enemyOf(team);
    let tx;
    let ty;
    const target = kind === 'giant' ? pickFrontKid(enemy, x0) : pickTargetKid(team);
    if (kind !== 'small' || Math.random() < 0.7) {
      // aim at an enemy kid's chest (anchor y − 6)
      tx = target.x + rand(-5, 5);
      ty = target.y - 6 + rand(-3, 3);
    } else {
      // stray shot: smacks into the enemy's snow wall area
      tx = rand(8, FIELD_W - 8);
      ty = fortY(enemy) - 4 + rand(-4, 4);
    }
    const dist = Math.hypot(tx - x0, ty - y0);
    b.active = true;
    b.team = team;
    b.kind = kind;
    b.x0 = x0; b.y0 = y0; b.z0 = z0;
    b.x1 = tx; b.y1 = ty;
    b.t = 0;
    b.dur = Math.max(0.15, dist / spec.speed);
    b.peak = clamp(spec.peakK * dist, spec.peakMin, spec.peakMax);
    b.x = x0; b.y = y0; b.z = z0;
    b.usd = 0;
    b.trail = null;
    b.trailDist = 0;
    b.trailLive = 0;
    b.px = x0;
    b.py = y0 - z0;
    hooks.onThrow?.(team, kind);
    return b;
  }

  function pickFrontKid(team, nearX) {
    let best = null;
    let bestD = Infinity;
    for (const k of s.kids) {
      if (k.team !== team || k.row !== 'front') continue;
      const d = Math.abs(k.x - nearX) + Math.random() * 40;
      if (d < bestD) { bestD = d; best = k; }
    }
    return best;
  }

  function setKid(k, state, dur) {
    k.state = state;
    k.t = 0;
    k.dur = dur;
  }

  function startThrow(k, big) {
    k.big = big;
    setKid(k, 'windup', rand(0.18, 0.26));
  }

  // Random idle kid of a team that has been idle ≥ 0.25 s (front row preferred for big balls).
  function pickIdleKid(team, preferFront) {
    let pick = null;
    let n = 0;
    for (const k of s.kids) {
      if (k.team !== team || k.state !== 'idle' || k.t < 0.25) continue;
      const w = preferFront && k.row === 'front' ? 3 : 1;
      n += w;
      if (Math.random() * n < w) pick = k;
    }
    return pick;
  }

  function spawnGiant(team, usd) {
    const used = s.giants.filter((g) => g.team === team).map((g) => g.x);
    const free = GIANT_XS.filter((x) => !used.includes(x));
    if (!free.length) return;
    const x = free[Math.floor(Math.random() * free.length)];
    const y = giantY(team);
    s.giants.push({ team, view: viewOf(team), x, y, t: 0, thrown: false, usd });
    spawnFx('puff', x - 8, y);
    spawnFx('puff', x + 8, y);
  }

  // ---------- impacts ----------
  function impact(b) {
    const enemy = enemyOf(b.team);
    const small = b.kind === 'small';
    spawnFx(small ? 'splash_small' : 'splash_big', b.x1, b.y1);
    let hitAny = false;
    const r = small ? SMALL.hitR : BIG.hitR;
    for (const k of s.kids) {
      if (k.team !== enemy || s.winner) continue;
      const d = Math.hypot(k.x - b.x1, k.y - 6 - b.y1);
      if (d < r && k.state !== 'duck') {
        setKid(k, 'hit', rand(0.25, 0.3));
        hitAny = true;
      } else if (!small && d < BIG.duckR && k.state !== 'hit') {
        setKid(k, 'duck', rand(0.6, 1.2));
      }
    }
    if (b.kind === 'big') {
      camera.shake(1, 0.2);
    } else if (b.kind === 'giant') {
      const huge = b.usd >= 5_000_000;
      camera.shake(huge ? 3 : 2, huge ? 0.5 : 0.4);
      for (let i = 0; i < 4; i++) {
        const a = (i / 4) * Math.PI * 2 + Math.random();
        spawnFx('splash_small', b.x1 + Math.cos(a) * 12, b.y1 + Math.sin(a) * 7);
      }
      spawnFx('puff', b.x1 - 10, b.y1 + 4);
      spawnFx('puff', b.x1 + 10, b.y1 + 4);
      burst(b.x1, b.y1, reducedMotion ? 6 : 18, PALETTE.w, PALETTE.b);
    }
    hooks.onImpact?.(b.kind, hitAny);
  }

  function spawnTrail(b) {
    const q = s.trails.find((o) => !o.active);
    if (!q) return;
    const tr = b.trail;
    q.active = true;
    q.ball = b;
    q.kind = tr.kind;
    q.x = b.x + rand(-1, 1);
    q.y = b.y - b.z + rand(-1, 1);
    q.vy = 0;
    q.age = 0;
    q.ph = Math.random() * 6.28;
    q.color = tr.colors[(Math.random() * tr.colors.length) | 0];
    q.flip = tr.kind.confetti && Math.random() < 0.5; // half the confetti flips 1×1 ↔ 2×1
    q.wide = false;
    b.trailLive++;
  }

  function updateTrails(dt) {
    for (const q of s.trails) {
      if (!q.active) continue;
      q.age += dt;
      const k = q.kind;
      if (q.age >= k.life) {
        q.active = false; // pops out, no fade
        if (q.ball.trailLive > 0) q.ball.trailLive--;
        continue;
      }
      q.vy += k.gravity * dt;
      q.y += (q.vy + k.fall) * dt;
      if (k.wobble) q.x += Math.sin(q.age * 12 + q.ph) * k.wobble * dt;
      q.wide = q.flip && Math.floor(q.age / 0.1) % 2 === 1;
    }
  }

  function burst(x, y, n, c1, c2) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const v = rand(15, 45);
      spawnParticle(x, y, Math.cos(a) * v, Math.sin(a) * v - 25, rand(0.4, 0.8), i % 2 ? c1 : c2);
    }
  }

  // ---------- per-frame update ----------
  function updateKids(dt) {
    for (const k of s.kids) {
      // Kids ride their army's anchor exactly like the forts do (no separate easing), so a
      // kid never detaches from its fort. Retreat = shoved (instant), advance = eased run.
      const ty = rowY(k.team, k.row);
      const dy = ty - k.y;
      k.y = ty;
      const pushed = k.team === 'red' ? -dy : dy; // > 0: moved toward its own end zone
      k.pushAcc *= Math.exp(-dt * 3);
      if (pushed > 0) {
        k.pushAcc += pushed;
        // a hard shove (≈6 px within a fraction of a second) knocks them into a duck
        if (k.pushAcc > 6 && !s.winner && (k.state === 'idle' || k.state === 'windup')) {
          k.big = false;
          k.pushAcc = 0;
          setKid(k, 'duck', rand(0.4, 0.7));
          spawnFx('puff', k.x, k.y);
        }
      }
      k.moving = dt > 0 && Math.abs(dy) / dt > 4; // running → step bob in the renderer
      if (k === s.myKid) maybeSpawnFootprint(Math.abs(dy));
      k.t += dt;

      if (s.winner) continue; // cheer/duck loops until the new round
      switch (k.state) {
        case 'idle':
          if (k.t >= k.dur) {
            if (Math.random() < 0.2) setKid(k, 'duck', rand(1, 1.5));
            else setKid(k, 'idle', rand(1, 3));
          }
          break;
        case 'windup':
          if (k.t >= k.dur) {
            setKid(k, 'throw', 0.2);
            const rel = RELEASE[k.view];
            const ball = spawnBall(k.team, k.x + rel.dx, k.y, rel.z, k.big ? 'big' : 'small');
            if (ball && k === s.myKid && s.myTrail) ball.trail = s.myTrail; // equipped throw trail
            k.big = false;
          }
          break;
        case 'throw':
          if (k.t >= k.dur) setKid(k, 'idle', rand(0.6, 2));
          break;
        case 'hit':
          if (k.t >= k.dur) setKid(k, 'duck', rand(0.5, 1));
          break;
        case 'duck':
          if (k.t >= k.dur) setKid(k, 'idle', rand(0.4, 2));
          break;
        case 'cheer': // reaction cheer (victory cheers never reach here: s.winner skips the switch)
          if (k.t >= k.dur) setKid(k, 'idle', rand(0.4, 1.2));
          break;
        default:
          break;
      }
    }
  }

  function updateThrowDemand(dt) {
    if (s.winner) return;
    for (const team of ['green', 'red']) {
      // aggression: 0..1 share of order flow for this team; floor keeps the field alive
      const aggr = team === 'green' ? (1 + s.pressure) / 2 : (1 - s.pressure) / 2;
      acc[team] = Math.min(2.5, acc[team] + dt * (0.5 + 2.5 * aggr));
      if (pendingBig[team] > 0) {
        const k = pickIdleKid(team, true);
        if (k) {
          startThrow(k, true);
          pendingBig[team]--;
        }
      }
      while (acc[team] >= 1) {
        const k = pickIdleKid(team, false);
        if (!k) break;
        startThrow(k, false);
        acc[team] -= 1;
      }
    }
  }

  function updateGiants(dt) {
    for (let i = s.giants.length - 1; i >= 0; i--) {
      const g = s.giants[i];
      g.t += dt;
      g.y = giantY(g.team);
      if (!g.thrown && g.t >= GIANT_T.release) {
        g.thrown = true;
        const b = spawnBall(g.team, g.x + RELEASE.giant.dx, g.y, RELEASE.giant.z, 'giant');
        if (b) b.usd = g.usd;
      }
      if (g.t >= GIANT_T.vanish) {
        spawnFx('puff', g.x - 6, g.y);
        spawnFx('puff', g.x + 6, g.y - 2);
        s.giants.splice(i, 1);
      }
    }
  }

  function updateBalls(dt) {
    for (const b of s.balls) {
      if (!b.active) continue;
      b.t += dt / b.dur;
      if (b.t >= 1) {
        b.active = false;
        impact(b);
        continue;
      }
      const t = b.t;
      b.x = b.x0 + (b.x1 - b.x0) * t;
      b.y = b.y0 + (b.y1 - b.y0) * t;
      b.z = b.z0 * (1 - t) + 4 * b.peak * t * (1 - t);
      if (b.trail) {
        // owner's trail (DESIGN.md §11): one particle per 2 px of drawn travel, ≤ 24 live per ball
        const dx = b.x - b.px;
        const dy = b.y - b.z - b.py;
        b.trailDist += Math.sqrt(dx * dx + dy * dy);
        b.px = b.x;
        b.py = b.y - b.z;
        while (b.trailDist >= 2) {
          b.trailDist -= 2;
          if (b.trailLive < TRAIL_MAX_PER_BALL) spawnTrail(b);
        }
      }
    }
  }

  function updateFx(dt) {
    for (const f of s.fx) {
      if (!f.active) continue;
      f.t += dt;
      if (f.t >= f.len) f.active = false;
    }
    for (const p of s.particles) {
      if (!p.active) continue;
      p.age += dt;
      if (p.age >= p.life) { p.active = false; continue; }
      if (p.static) continue; // frost-step footprints: sit still, pop out at the end
      p.vy += 90 * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
    }
    for (const f of s.flakes) {
      f.y += f.v * dt;
      f.x += 4 * Math.sin(s.time + f.ph) * dt;
      if (f.y > s.H + 2) { f.y = -2; f.x = Math.random() * W; }
    }
  }

  function updateLine(borderT, dt) {
    s.borderT = clamp(borderT, 0, 1);
    s.F = s.Fmin + s.borderT * (s.Fmax - s.Fmin);
    // armies follow the line quickly when it retreats, and are shoved instantly when it advances
    const k = Math.min(1, dt * 8);
    s.anchor.red = Math.min(s.F, s.anchor.red + (s.F - s.anchor.red) * k);
    s.anchor.green = Math.max(s.F, s.anchor.green + (s.F - s.anchor.green) * k);
    lineRefT += dt;
    if (lineRefT >= 1) {
      if (Math.abs(s.F - lineRefF) > 3) {
        const n = 2 + (Math.random() < 0.5 ? 1 : 0);
        for (let i = 0; i < n; i++) spawnFx('puff', rand(8, FIELD_W - 8), s.F + rand(-2, 4));
      }
      lineRefF = s.F;
      lineRefT = 0;
    }
  }

  function updateConfetti(dt) {
    if (!s.winner || s.time > confettiUntil) return;
    const rate = reducedMotion ? 10 : 50; // particles per second
    const n = Math.floor(rate * dt + Math.random());
    const team = TEAM_COLORS[s.winner];
    const baseY = rowY(s.winner, 'front') - 10; // fountain from the winners' front row
    for (let i = 0; i < n; i++) {
      const c = i % 3 === 0 ? team.H : i % 3 === 1 ? PALETTE.w : PALETTE.Y;
      spawnParticle(rand(4, FIELD_W - 4), baseY, rand(-20, 20), rand(-80, -40), rand(0.8, 1.4), c);
    }
  }

  function update(dt, { borderT, pressure }) {
    s.time += dt;
    s.pressure = pressure || 0;
    updateLine(borderT, dt);
    updateThrowDemand(dt);
    updateKids(dt);
    updateGiants(dt);
    updateBalls(dt);
    updateTrails(dt);
    updateFx(dt);
    updateConfetti(dt);
    camera.update(dt);
  }

  // ---------- external events ----------
  return {
    state: s,
    // v1.07: the owner's kid = centre front-row kid of the team they back today.
    // v1.08: `aura` is the equipped AURAS entry (or null); only mode:'steps' spawns footprints
    // here — ring/outline/orbit auras are drawn directly by kid-art.js.
    setMyKid(team, trailId, trailColors, aura) {
      s.myKid = s.kids.find((k) => k.team === team && k.row === 'front' && k.x === 84) || null;
      const kind = TRAIL_KIND[trailId];
      s.myTrail = kind && trailColors?.length ? { kind, colors: trailColors } : null;
      s.myAuraSteps = aura?.mode === 'steps'
        ? { color: aura.colors?.[0] || PALETTE.b, everyPx: aura.everyPx || 4, lifeMs: aura.lifeMs || 1200, max: aura.max || 6, dist: 0 }
        : null;
    },
    // ✓ → cheer with a gold sparkle, ✗ → hit (then the usual duck)
    reactMyKid(win) {
      const k = s.myKid;
      if (!k || s.winner) return;
      if (win) {
        setKid(k, 'cheer', 1.4);
        for (let i = 0; i < (reducedMotion ? 4 : 12); i++) {
          const a = Math.random() * Math.PI * 2;
          spawnParticle(k.x + Math.cos(a) * 4, k.y - 12 + Math.sin(a) * 3, Math.cos(a) * rand(10, 22), -rand(15, 35), rand(0.5, 0.9), i % 2 ? PALETTE.Y : PALETTE.y);
        }
      } else {
        setKid(k, 'hit', rand(0.25, 0.3));
      }
    },
    resize,
    update,
    rowY, fortY, giantY,
    // any trade adds a little throw demand for its side
    trade(side, usd) {
      const team = teamOf(side);
      acc[team] = Math.min(2.5, acc[team] + Math.min(0.5, usd / 25000));
    },
    bigprint(bp) {
      if (s.winner) return;
      const team = teamOf(bp.side);
      if (bp.tier === 'giant') spawnGiant(team, bp.usd);
      else pendingBig[team] = Math.min(2, pendingBig[team] + 1);
    },
    victory(winner) {
      s.winner = winner;
      confettiUntil = s.time + 1.6;
      pendingBig.green = pendingBig.red = 0;
      acc.green = acc.red = 0;
      for (const k of s.kids) setKid(k, k.team === winner ? 'cheer' : 'duck', Infinity);
      camera.shake(1, 0.3);
    },
    newRound() {
      s.winner = null;
      makeWobble();
      for (const k of s.kids) setKid(k, 'idle', rand(0.3, 1.5));
    },
    init(H, insetTop, insetBottom) {
      makeWobble();
      resize(H, insetTop, insetBottom);
    },
  };
}
