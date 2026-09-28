// Deterministic PvP duel simulation (gamification/PVP-SPEC.md §1-§6, §9). No DOM, no Date.now(),
// no Math.random() — every random choice is drawn from a mulberry32 PRNG seeded once per match,
// and the match advances in fixed 1/60 s ticks. The same {seed, myPoints, botTier, wind, log}
// replayed through runReplay() always yields the same result — this is the module v1.1's server
// will import unmodified to re-simulate a match from the client's input log (§9 anti-cheat).
//
// Numbers are plain floats, not the integer ×1000 fixed-point §9 asks for eventually: v1.08 is
// bot-only and never leaves this one JS engine, so float determinism (same engine, same seed,
// same ordered inputs → bit-identical results) already satisfies the acceptance test. Switching
// the arithmetic to fixed-point integers is a mechanical follow-up for v1.1 when a second
// runtime (the server) must reproduce the exact same match.

export const TICK_HZ = 60;
export const TICK_DT = 1 / TICK_HZ;
export const DUEL_TICKS = 45 * TICK_HZ;
export const SUDDEN_DEATH_TICKS = 15 * TICK_HZ;
export const ARENA_W = 192;
export const LANES_X = [32, 96, 160];
export const HITBOX_PX = 5;
export const FORT_HP = 4;
export const BALL_SPEED = 150;   // px/s, normal
export const POWER_SPEED = 110;  // px/s, power + giant
export const GIANT_DMG = 20;
export const STAM_COST = { power: 35, step: 6, duckPerSec: 14 };
export const CHARGE_MIN_TICKS = Math.round(0.2 * TICK_HZ); // 200 ms hold → power throw
export const CHARGE_MAX_TICKS = Math.round(0.8 * TICK_HZ); // v1.081: ring fills over ~0.8 s

// ---------- input log codes (v1.081, §9) ----------
// Every entry is [dtTicks, code] — no per-entry payload. A throw is two entries: THROW_START
// when the hold begins, THROW_RELEASE when it ends; the tick gap between them IS the charge
// (chargeTicks), so replay never has to trust a client-reported number. Lane targeting isn't
// logged either — it's computed deterministically from the foe's tracked lane + the seeded RNG
// (autoAimLane below), identically for the player's throw button and the bot's AI.
export const CODE = {
  MOVE_L: 0, MOVE_R: 1, DUCK_ON: 2, DUCK_OFF: 3, THROW_START: 4, THROW_RELEASE: 5, GIANT: 6,
};

// ---------- seeded PRNG ----------
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function rnd() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function gauss(rnd) {
  let u = 0; let v = 0;
  while (!u) u = rnd();
  while (!v) v = rnd();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// ---------- stats (§4.2) ----------
export const eff = (p) => Math.min(p, 5) + 0.5 * Math.max(0, p - 5);
export const bon = (p) => 0.016 * eff(p);
export function deriveStats(points) {
  const b = points.map(bon);
  return {
    cd: 1 / (1 + b[0]),
    dmg: 10 * (1 + b[1]),
    // v1.081: accuracy still sets the lateral scatter around the lane centre (sigma, unchanged
    // formula), and now also feeds leadChance — the odds an auto-aimed throw reads a step in
    // progress and targets the lane the foe is moving INTO instead of the one they're leaving.
    sigma: 5.5 - 0.12 * eff(points[2]),
    leadChance: Math.min(0.5, 0.05 * eff(points[2])),
    step: 0.26 * (1 - 1.5 * b[3]),
    duckIn: 0.12 * (1 - 1.5 * b[3]),
    stamMax: 100 * (1 + 2 * b[4]),
    regen: 15 * (1 + 2 * b[4]),
  };
}
export const ZERO_POINTS = [0, 0, 0, 0, 0];

// ---------- bots (§6.1, §6.2) ----------
// react: [meanMs, sigmaMs]; dodge/power/lapse are 0..1 probabilities. `predict` (T3+) is an
// extra lead bias layered onto the bot's own accuracy-driven leadChance (v1.081, see autoAimLane
// below) — it's what §6.1 calls "упреждение": the bot reads your step, same mechanism the
// player's own accuracy stat drives, just with a tier-scaled head start.
export const BOT_TIERS = {
  T1: { react: [650, 150], dodge: 0.25, power: 0, giant: false, lapse: 0.15, gapTicks: 50 },
  T2: { react: [500, 120], dodge: 0.45, power: 0.15, giant: true, lapse: 0.10, gapTicks: 40 },
  T3: { react: [400, 100], dodge: 0.65, power: 0.30, giant: true, lapse: 0.07, gapTicks: 32, predict: 0.3 },
  T4: { react: [320, 80], dodge: 0.80, power: 0.40, giant: true, lapse: 0.05, gapTicks: 24, predict: 0.6 },
  T5: { react: [260, 60], dodge: 0.88, power: 0.45, giant: true, lapse: 0.03, gapTicks: 20, predict: 0.75, feint: true },
};
export const TIER_ORDER = ['T1', 'T2', 'T3', 'T4', 'T5'];

// habit: mirror = target the player's current lane always; camp = ducks more, throws less often;
// aggressive = shorter gap between throws; power = throws power shots more often.
export const BOT_PERSONAS = [
  { id: 'timokha', tier: 'T1', habit: {} },
  { id: 'barsik', tier: 'T1', habit: { wander: true } },
  { id: 'serega', tier: 'T2', habit: { aggressive: true } },
  { id: 'snezhana', tier: 'T2', habit: { center: true } },
  { id: 'kirpich', tier: 'T3', habit: { power: true } },
  { id: 'petrovy', tier: 'T3', habit: { mirror: true } },
  { id: 'vitya', tier: 'T3', habit: { camp: true } },
  { id: 'palych', tier: 'T4', habit: { aggressive: true } },
  { id: 'alyonka', tier: 'T4', habit: { sniper: true } },
  { id: 'batya', tier: 'T5', habit: { feint: true, giantRush: true } },
];
export const personaOf = (id) => BOT_PERSONAS.find((p) => p.id === id) || BOT_PERSONAS[0];
export const personasOfTier = (tier) => BOT_PERSONAS.filter((p) => p.tier === tier);

// ---------- leagues (§6.4) ----------
export const LEAGUES = [
  { id: 'bronze', min: -Infinity, tiers: ['T1', 'T2'] },
  { id: 'silver', min: 1100, tiers: ['T2', 'T3'] },
  { id: 'gold', min: 1250, tiers: ['T3', 'T4'] },
  { id: 'ice', min: 1400, tiers: ['T4', 'T5'] },
  { id: 'aurora', min: 1600, tiers: ['T5'] },
];
export function leagueFor(rating) {
  let cur = LEAGUES[0];
  for (const l of LEAGUES) if (rating >= l.min) cur = l;
  return cur;
}
export const RATING_DELTA = { win: 18, loss: -12, draw: 3 };
export const RATING_FLOOR_AFTER_SILVER = 1100;

// pick a bot tier (biased toward the lower end of the league band) + a matching persona.
export function pickBot(rating, rnd, difficultyStep = 0) {
  const league = leagueFor(rating);
  let idx = TIER_ORDER.indexOf(league.tiers[rnd() < 0.6 ? 0 : league.tiers.length - 1]);
  idx = Math.max(0, Math.min(TIER_ORDER.length - 1, idx + difficultyStep));
  const tier = TIER_ORDER[idx];
  const pool = personasOfTier(tier);
  const persona = pool[Math.floor(rnd() * pool.length)] || pool[0];
  return { tier, persona: persona.id };
}

// bot point budget: player's total ±1 (§4.3), spread roughly like a player would.
export function botPointsBudget(myPoints, rnd) {
  const total = myPoints.reduce((a, b) => a + b, 0);
  const delta = total > 0 ? (rnd() < 0.5 ? -1 : rnd() < 0.5 ? 0 : 1) : 0;
  let budget = Math.max(0, total + delta);
  const pts = [0, 0, 0, 0, 0];
  while (budget > 0) {
    const i = Math.floor(rnd() * 5);
    if (pts[i] >= 10) continue;
    pts[i]++;
    budget--;
  }
  return pts;
}

// ---------- kid ----------
function mkKid(team, points) {
  const d = deriveStats(points);
  return {
    team, points, d, lane: 1, x: LANES_X[1], fromLane: 1, stepTicksLeft: 0, stepDurTicks: Math.round(d.step * TICK_HZ),
    duck: false, duckUntilTick: 0, cdTicks: Math.round(0.6 * TICK_HZ), stam: d.stamMax, hp: 100,
    combo: 0, hitStreak: 0, bestHitStreak: 0, giants: 0, hits: 0, throws: 0,
    animState: 'idle', animTicksLeft: 0, chargeStartTick: -1,
  };
}
export const kidX = (k) => (k.stepTicksLeft > 0
  ? LANES_X[k.fromLane] + (LANES_X[k.lane] - LANES_X[k.fromLane]) * (1 - k.stepTicksLeft / k.stepDurTicks)
  : LANES_X[k.lane]);

// ---------- match ----------
// cfg: { seed, myPoints, botTier, botPersona, botPoints, y:{me,op}, practice, windSeries }
// windSeries: [[fromTick, value], ...] — sampled by the caller from live market pressure (or
// forced to 0 for the first 3 duels / practice / DEMO, §5.4-§5.5); the sim never reads pressure
// itself, so the same windSeries + log always replays identically.
export function createMatch(cfg) {
  const rnd = mulberry32(cfg.seed >>> 0);
  const me = mkKid('green', cfg.myPoints || ZERO_POINTS);
  const op = mkKid('red', cfg.botPoints || ZERO_POINTS);
  me.y = cfg.y?.me ?? 0;
  op.y = cfg.y?.op ?? 0;
  const tierCfg = BOT_TIERS[cfg.botTier] || BOT_TIERS.T1;
  const persona = personaOf(cfg.botPersona);
  return {
    cfg, rnd, tick: 0, phase: 'count', countTicks: Math.round(2.2 * TICK_HZ),
    leftTicks: DUEL_TICKS, sdTicks: SUDDEN_DEATH_TICKS,
    me, op, balls: [], fx: [], forts: { green: [FORT_HP, FORT_HP, FORT_HP], red: [FORT_HP, FORT_HP, FORT_HP] },
    myFortHits: 0, opFortHits: 0, giant: null,
    bot: {
      tier: cfg.botTier, tierCfg, persona, nextThrowTick: 0, lapseUntilTick: 0, nextLapseCheckTick: 300, diffStep: cfg.diffStep || 0,
    },
    wind: 0, windSeries: cfg.windSeries || [[0, 0]], windIdx: 0, windLog: [],
    practice: !!cfg.practice, log: [], lastLogTick: 0, result: null, maxHeadwind: 0,
  };
}

function foe(state, k) { return k === state.me ? state.op : state.me; }
const who = (state, k) => (k === state.me ? 'me' : 'op');

function applyWind(state) {
  const w = state.windSeries;
  while (state.windIdx + 1 < w.length && w[state.windIdx + 1][0] <= state.tick) state.windIdx++;
  const v = w[state.windIdx] ? w[state.windIdx][1] : 0;
  if (v !== state.wind) { state.wind = v; state.windLog.push([state.tick, v]); }
  if (v < state.maxHeadwind) state.maxHeadwind = v; // most negative = worst headwind faced
}

// ---------- actions (shared by live input, bot AI and replay) ----------
export function doStep(state, k, dir) {
  if (state.phase !== 'fight' && state.phase !== 'sudden') return false;
  if (k.stepTicksLeft > 0 || k.duck) return false;
  const nl = k.lane + dir;
  if (nl < 0 || nl > 2 || k.stam < STAM_COST.step) return false;
  k.stam -= STAM_COST.step;
  k.fromLane = k.lane; k.lane = nl; k.stepTicksLeft = k.stepDurTicks;
  return true;
}
export function setDuck(state, k, on) {
  if (on && (state.phase !== 'fight' && state.phase !== 'sudden')) return;
  if (on && k.stepTicksLeft > 0) return;
  k.duck = on;
}
// ---------- auto-aim (v1.081, PVP-SPEC.md §3 addendum) ----------
// A throw always targets the lane the foe occupies right now: while they're mid-step it's the
// lane they're leaving (fromLane) — they haven't actually arrived in the new one yet, so a dodge
// in progress isn't punished for free. With probability `lead` (driven by the thrower's own
// accuracy stat, §4.2, d.leadChance) the aim instead reads the step and targets the lane they're
// moving INTO, catching an early dodge. The player's throw button and the bot's AI both call this
// exact function — "the bot uses exactly the same auto-aim" (owner request).
export function autoAimLane(state, target, lead) {
  if (target.stepTicksLeft > 0) return state.rnd() < lead ? target.lane : target.fromLane;
  return target.lane;
}
export function doThrow(state, k, lane, chargeTicks = 0) {
  if (state.phase !== 'fight' && state.phase !== 'sudden') return false;
  if (k.cdTicks > 0 || k.duck || k.stepTicksLeft > 0) return false;
  let power = chargeTicks >= CHARGE_MIN_TICKS;
  if (power && k.stam < STAM_COST.power) power = false;
  if (power) k.stam -= STAM_COST.power;
  const f = foe(state, k);
  const me = k === state.me;
  const x0 = me ? kidX(k) + 5 : kidX(k) + 1;
  const y0 = k.y;
  const z0 = me ? 13 : 6;
  const targetX = LANES_X[lane] + gauss(state.rnd) * k.d.sigma;
  const y1 = f.y - 2;
  const dist = Math.hypot(targetX - x0, y1 - y0);
  const windMul = me ? 1 + state.wind : 1 - state.wind;
  const speed = (power ? POWER_SPEED : BALL_SPEED) * windMul;
  state.balls.push({
    owner: k, lane, x0, y0, z0, x1: targetX, y1, ageTicks: 0, durTicks: Math.max(1, Math.round((dist / speed) * TICK_HZ)),
    big: power, giant: false, reactTicks: null, dodgeDecided: false,
  });
  k.cdTicks = Math.round(k.d.cd * TICK_HZ);
  k.animState = 'throw'; k.animTicksLeft = Math.round(0.2 * TICK_HZ);
  k.throws++;
  return true;
}
export function summonGiant(state, k) {
  if (k.combo < 3 || k.giants >= 2 || state.giant) return false;
  k.combo = 0; k.giants++;
  state.giant = { k, ageTicks: 0, fired: false, lane: k.lane };
  return true;
}

function land(state, ball) {
  const f = foe(state, ball.owner);
  const fx = kidX(f);
  const sameLane = Math.abs(LANES_X[ball.lane] - fx) < 1 && f.stepTicksLeft <= 0;
  const inHitbox = Math.abs(ball.x1 - fx) <= HITBOX_PX && f.stepTicksLeft <= 0;
  const forts = state.forts[f.team];
  if (sameLane && f.duck && forts[ball.lane] > 0 && !ball.giant) {
    forts[ball.lane] = Math.max(0, forts[ball.lane] - (ball.big ? 3 : 1));
    if (f === state.me) state.myFortHits++; else state.opFortHits++;
    ball.owner.hitStreak = 0;
    return 'fort';
  }
  if (inHitbox) {
    const dmg = ball.giant ? GIANT_DMG : ball.owner.d.dmg * (ball.big ? 2 : 1);
    f.hp = Math.max(0, f.hp - dmg);
    f.animState = 'hit'; f.animTicksLeft = Math.round(0.3 * TICK_HZ); f.combo = 0;
    ball.owner.hits++; ball.owner.hitStreak++;
    ball.owner.bestHitStreak = Math.max(ball.owner.bestHitStreak, ball.owner.hitStreak);
    if (!ball.giant) ball.owner.combo++;
    return 'hit';
  }
  ball.owner.hitStreak = 0;
  return 'miss';
}

// ---------- bot AI (§6.1: decisions every 100 ms = 6 ticks, reaction ≥ 180 ms) ----------
function botThink(state) {
  const b = state.op; const B = state.bot; const T = B.tierCfg; const habit = B.persona.habit;
  if (state.tick < B.lapseUntilTick) return;
  if (state.tick >= B.nextLapseCheckTick) {
    B.nextLapseCheckTick = state.tick + 5 * TICK_HZ;
    if (state.rnd() < T.lapse) B.lapseUntilTick = state.tick + Math.round((0.6 + state.rnd() * 0.9) * TICK_HZ);
  }
  // react to my incoming balls aimed at the bot's own lane (sees the landing shadow at launch)
  let threat = null;
  for (const ball of state.balls) {
    if (ball.owner !== state.me || ball.lane !== b.lane) continue;
    if (ball.reactTicks == null) {
      const ms = Math.max(180, T.react[0] + gauss(state.rnd) * T.react[1]);
      ball.reactTicks = Math.round((ms / 1000) * TICK_HZ);
      ball.dodgeDecided = state.rnd() < T.dodge;
    }
    if (ball.dodgeDecided && ball.ageTicks >= ball.reactTicks) threat = ball;
  }
  if (threat) {
    const remainTicks = threat.durTicks - threat.ageTicks;
    if (!threat.giant && state.forts.red[b.lane] > 0 && state.rnd() < 0.5) {
      setDuck(state, b, true); b.duckUntilTick = state.tick + remainTicks + Math.round(0.25 * TICK_HZ);
    } else if (remainTicks > b.stepDurTicks * 0.7) {
      doStep(state, b, b.lane === 0 ? 1 : b.lane === 2 ? -1 : (state.rnd() < 0.5 ? -1 : 1));
    }
    return;
  }
  if (b.duck && state.tick > b.duckUntilTick) setDuck(state, b, false);
  if (b.combo >= 3 && b.giants < 2 && !state.giant && T.giant) { summonGiant(state, b); return; }
  const gap = habit.aggressive ? Math.round(T.gapTicks * 0.6) : T.gapTicks;
  if (b.cdTicks <= 0 && !b.duck && b.stepTicksLeft <= 0 && state.tick > B.nextThrowTick) {
    const lead = Math.min(0.9, (T.predict || 0) + b.d.leadChance);
    const lane = autoAimLane(state, state.me, lead);
    const powerChance = habit.power ? T.power * 1.6 : habit.sniper ? T.power * 0.5 : T.power;
    const chargeTicks = state.rnd() < powerChance ? CHARGE_MIN_TICKS + 4 : 0;
    doThrow(state, b, lane, chargeTicks);
    B.nextThrowTick = state.tick + gap + Math.floor(state.rnd() * gap * 0.6);
  } else if (habit.wander && state.rnd() < 0.004) {
    doStep(state, b, state.rnd() < 0.5 ? -1 : 1);
  }
}

// ---------- one 1/60 s tick. meActions: decoded [code, ...] for this tick (may be empty). ----------
export function tick(state, meActions = []) {
  if (state.phase === 'end') return;
  state.tick++;
  applyWind(state);
  if (state.phase === 'count') {
    state.countTicks--;
    if (state.countTicks <= 0) state.phase = 'fight';
    return;
  }
  for (const code of meActions) applyCode(state, state.me, code);
  botThink(state);

  for (const k of [state.me, state.op]) {
    if (k.cdTicks > 0) k.cdTicks--;
    if (k.animTicksLeft > 0) k.animTicksLeft--;
    if (k.stepTicksLeft > 0) k.stepTicksLeft--;
    if (k.duck) {
      k.stam -= STAM_COST.duckPerSec * TICK_DT;
      if (k.stam <= 0) { k.stam = 0; k.duck = false; }
    } else {
      k.stam = Math.min(k.d.stamMax, k.stam + k.d.regen * TICK_DT);
    }
  }

  let suddenHit = null;
  for (let i = state.balls.length - 1; i >= 0; i--) {
    const ball = state.balls[i];
    ball.ageTicks++;
    if (ball.ageTicks >= ball.durTicks) {
      state.balls.splice(i, 1);
      const outcome = land(state, ball);
      if (state.phase === 'sudden' && outcome === 'hit') suddenHit = ball.owner;
    }
  }
  if (state.giant) {
    const G = state.giant; G.ageTicks++;
    if (!G.fired && G.ageTicks >= Math.round(0.55 * TICK_HZ)) {
      G.fired = true;
      const f = foe(state, G.k);
      state.balls.push({
        owner: G.k, lane: f.lane, x0: LANES_X[G.lane], y0: G.k.y, z0: 20,
        x1: LANES_X[f.lane], y1: f.y - 2, ageTicks: 0, durTicks: Math.round((1.3 / 1) * TICK_HZ), big: true, giant: true,
      });
    }
    if (G.ageTicks >= Math.round(1.2 * TICK_HZ)) state.giant = null;
  }

  if (state.phase === 'fight') {
    state.leftTicks--;
    if (state.me.hp <= 0 || state.op.hp <= 0) return endMatch(state, state.op.hp <= 0 && state.me.hp > 0 ? 'me' : state.me.hp <= 0 && state.op.hp > 0 ? 'op' : (state.op.hp < state.me.hp ? 'me' : state.op.hp > state.me.hp ? 'op' : 'draw'));
    if (state.leftTicks <= 0) {
      if (state.me.hp === state.op.hp) { state.phase = 'sudden'; return; }
      return endMatch(state, state.me.hp > state.op.hp ? 'me' : 'op');
    }
  } else if (state.phase === 'sudden') {
    state.sdTicks--;
    if (state.me.hp <= 0 || state.op.hp <= 0) return endMatch(state, state.op.hp <= 0 ? 'me' : 'op');
    if (suddenHit) return endMatch(state, who(state, suddenHit));
    if (state.sdTicks <= 0) return endMatch(state, 'draw');
  }
}

function applyCode(state, k, code) {
  if (code === CODE.MOVE_L) doStep(state, k, -1);
  else if (code === CODE.MOVE_R) doStep(state, k, 1);
  else if (code === CODE.DUCK_ON) setDuck(state, k, true);
  else if (code === CODE.DUCK_OFF) setDuck(state, k, false);
  else if (code === CODE.GIANT) summonGiant(state, k);
  else if (code === CODE.THROW_START) k.chargeStartTick = state.tick;
  else if (code === CODE.THROW_RELEASE) {
    if (k.chargeStartTick < 0) return;
    const chargeTicks = Math.min(CHARGE_MAX_TICKS, Math.max(0, state.tick - k.chargeStartTick));
    k.chargeStartTick = -1;
    doThrow(state, k, autoAimLane(state, foe(state, k), k.d.leadChance), chargeTicks);
  }
}

function endMatch(state, winner) {
  state.phase = 'end';
  state.result = {
    winner, // 'me' | 'op' | 'draw'
    meHp: Math.ceil(state.me.hp), opHp: Math.ceil(state.op.hp),
    hits: state.me.hits, throws: state.me.throws, bestHitStreak: state.me.bestHitStreak,
    myFortHits: state.myFortHits, giants: state.me.giants,
    wind: state.wind, maxHeadwind: state.maxHeadwind, ticks: state.tick,
  };
}

// ---------- input log (§9 format) ----------
// Records an action taken by 'me' (called from the live input layer, at input time — i.e.
// before the tick that will actually apply it). state.tick is the last *processed* tick, and
// live play always applies a freshly queued action on the next tick() call, so the action's
// target tick is state.tick + 1 — exactly what runReplay()/decodeLog() below look up.
export function logMe(state, code) {
  const targetTick = state.tick + 1;
  const dt = targetTick - state.lastLogTick;
  state.lastLogTick = targetTick;
  state.log.push([dt, code]);
}

// Decode the log into a per-tick action map { tick: [code, ...] }.
export function decodeLog(log) {
  const byTick = new Map();
  let t = 0;
  for (const [dt, code] of log) {
    t += dt;
    const arr = byTick.get(t) || [];
    arr.push(code);
    byTick.set(t, arr);
  }
  return byTick;
}

// Pure replay: same cfg + log → same result, twice. Used by the ?pvptest=1 determinism check
// and, in v1.1, by the server. maxTicks bounds a runaway/incomplete log.
export function runReplay(cfg, log, maxTicks = (DUEL_TICKS + SUDDEN_DEATH_TICKS + 3 * TICK_HZ)) {
  const state = createMatch(cfg);
  const byTick = decodeLog(log);
  for (let i = 0; i < maxTicks && state.phase !== 'end'; i++) {
    tick(state, byTick.get(state.tick + 1) || []);
  }
  return state;
}
