// Achievements: the 15 from gamification/V105-CLIENT.md §3 + 4 forecast ones (phase 5).
// icon: [sprite, team, scale] (or 'hot5' composite). check(p, ctx) → boolean.
// progress(p) → [current, target] for locked cells with a numeric counter.
// ctx (only at a resolved guess): { guessWon, side:'g'|'r', giantSides:Set<'g'|'r'> }

export const RARITY_XP = { common: 50, rare: 150, epic: 400, legendary: 1000 };

const count = (v, target) => [Math.min(v || 0, target), target];

export const ACHIEVEMENTS = [
  { id: 'first_guess', rarity: 'common', icon: ['ball_big', 'green', 2], check: (p) => p.g[0] >= 1, progress: (p) => count(p.g[0], 1) },
  { id: 'bullseye', rarity: 'common', icon: ['ach_target', 'green', 2], check: (p) => p.g[1] >= 1, progress: (p) => count(p.g[1], 1) },
  { id: 'first_breakout', rarity: 'common', icon: ['crown', 'green', 2], check: (p) => p.rw >= 1, progress: (p) => count(p.rw, 1) },
  { id: 'hunch3', rarity: 'common', icon: ['ach_carrot', 'green', 2], check: (p) => p.g[2] >= 3, progress: (p) => count(p.g[2], 3) },
  { id: 'hot5', rarity: 'rare', icon: 'hot5', check: (p) => p.g[2] >= 5, progress: (p) => count(p.g[2], 5) },
  { id: 'oracle10', rarity: 'legendary', icon: ['ach_iceball', 'green', 2], check: (p) => p.g[2] >= 10, progress: (p) => count(p.g[2], 10) },
  { id: 'early_bird', rarity: 'common', icon: ['ach_bullfinch', 'green', 2], check: (p) => p.g[4] >= 10, progress: (p) => count(p.g[4], 10) },
  {
    id: 'whale_survivor', rarity: 'epic', icon: ['whale', 'green', 2],
    check: (p, ctx) => !!ctx?.guessWon && [...ctx.giantSides].some((s) => s !== ctx.side),
  },
  {
    id: 'whale_rider', rarity: 'rare', icon: ['giant_back_idle', 'green', 1],
    check: (p, ctx) => !!ctx?.guessWon && ctx.giantSides.has(ctx.side),
  },
  { id: 'avalanche', rarity: 'rare', icon: ['icon_bolt', 'green', 2], check: (p) => p.av >= 1, progress: (p) => count(p.av, 1) },
  { id: 'summoner', rarity: 'rare', icon: ['giant_back_idle', 'green', 1], check: (p) => p.gi >= 25, progress: (p) => count(p.gi, 25) },
  { id: 'week', rarity: 'rare', icon: ['ach_calendar', 'green', 2], check: (p) => p.st[0] >= 7, progress: (p) => count(p.st[0], 7) },
  { id: 'month', rarity: 'epic', icon: ['ach_icicle', 'green', 2], check: (p) => p.st[0] >= 30, progress: (p) => count(p.st[0], 30) },
  {
    id: 'loyal_green', rarity: 'rare', icon: ['icon_head_back', 'green', 2],
    check: (p) => p.ly?.[0] === 'g' && p.ly[1] >= 14, progress: (p) => count(p.ly?.[0] === 'g' ? p.ly[1] : 0, 14),
  },
  {
    id: 'loyal_red', rarity: 'rare', icon: ['icon_head_front', 'red', 2],
    check: (p) => p.ly?.[0] === 'r' && p.ly[1] >= 14, progress: (p) => count(p.ly?.[0] === 'r' ? p.ly[1] : 0, 14),
  },
  // phase 5: time-horizon forecasts (fh[h] = [made, won, streak, best, void]; fd = [day, wonMask])
  { id: 'scalper', rarity: 'common', icon: ['icon_bolt', 'green', 2], check: (p) => p.fh[0][1] >= 10, progress: (p) => count(p.fh[0][1], 10) },
  { id: 'swing', rarity: 'rare', icon: ['ach_flame', 'green', 2], check: (p) => p.fh[4][1] >= 5, progress: (p) => count(p.fh[4][1], 5) },
  { id: 'day_prophet', rarity: 'epic', icon: ['ach_calendar', 'green', 2], check: (p) => p.fh[5][1] >= 1, progress: (p) => count(p.fh[5][1], 1) },
  {
    id: 'full_spectrum', rarity: 'legendary', icon: ['crown', 'green', 2],
    check: (p) => p.fd[0] === p.day && p.fd[1] === 0b111111,
    progress: (p) => count(p.fd[0] === p.day ? popcount(p.fd[1]) : 0, 6),
  },
];

function popcount(n) {
  let c = 0;
  for (let x = n; x; x &= x - 1) c++;
  return c;
}

export const byId = Object.fromEntries(ACHIEVEMENTS.map((a) => [a.id, a]));

// Returns the definitions newly satisfied (not yet in p.a). Caller records + awards XP.
export function checkAll(p, ctx) {
  const out = [];
  for (const def of ACHIEVEMENTS) {
    if (p.a[def.id] != null) continue;
    try {
      if (def.check(p, ctx)) out.push(def);
    } catch { /* malformed profile field: skip */ }
  }
  return out;
}

// XP / level (SPEC §5.1): need(n) = 50 + 25·n to go from level n to n+1.
export function levelOf(xp) {
  let level = 1;
  let rest = xp;
  while (rest >= 50 + 25 * level) {
    rest -= 50 + 25 * level;
    level++;
  }
  return { level, into: rest, need: 50 + 25 * level };
}
