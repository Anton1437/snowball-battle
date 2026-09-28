// Progress store (gamification/V105-CLIENT.md §1): one small JSON profile, mirrored in
// localStorage and (in Telegram, Bot API ≥ 6.9) CloudStorage. Cloud writes are debounced to
// ≤ 1 per 5 s and flushed immediately when the app is hidden/closed. Counters merge by max so
// two devices never double-count; achievements merge by earliest day.

const DAY_MS = 86_400_000;
const CLOUD_DEBOUNCE_MS = 5000;
const CLOUD_RETRY_MS = 30000;
const MAX_CLOUD_CHARS = 4000;
const LOCK_EVERY_MS = 2000;
const LOCK_STALE_MS = 5000;

export const utcDayOf = (ms) => Math.floor(ms / DAY_MS);

export const SCHEMA_VERSION = 2;
export const HORIZON_COUNT = 6;
const emptyFh = () => Array.from({ length: HORIZON_COUNT }, () => [0, 0, 0, 0, 0]);

// v2 adds time-horizon forecasts (phase 5):
//   f:  active forecasts, ≤ 1 per horizon: [h, 'u'|'d', entryPrice, entryMs, src]
//       src: 'A' AGG · 'B' Binance · 'Y' Bybit · 'C' Coinbase
//   fh: per horizon [made, won, streak, bestStreak, void]
//   fd: [utcDay, bitmask of horizons won that day]   (Full Spectrum)
//   xd: [watch, guess, round, forecastShort(1м–15м), forecastLong(1ч–24ч)] daily XP
//   tu: 1 once the tutorial was seen
// v1.07 (optional fields, still v2 — defaults fill them in):
//   eq:   equipped cosmetics { h, s, m, t, f } → item id (absent = none). v1.08 cosmetics v2
//         (DESIGN.md §12) adds three more optional slot keys, still short catalog-id strings:
//         p (pet), k (back item), u (aura), x (trim).
//   seen: [notifiedMask, wardrobeViewedMask] over the append-only cosmetics catalog
// v1.08 (PVP-SPEC.md §10.1, optional field):
//   xd[5] = PvP XP for the day (xd now has 6 slots).
//   pv: { s:[5 skill points], rs: UTC day of the last free respec, e:[energy, msOfLastRecalc],
//         r: league-with-bots rating, w:[wins, losses, draws, streak, bestStreak],
//         c:[giant hits landed, T5 wins, 100HP wins, total duels], tu: 1 once the PvP tutorial
//         (first 3 duels) is done }
export function defaultPv(day) {
  return {
    s: [0, 0, 0, 0, 0], rs: day, e: [10, Date.now()], r: 1000,
    w: [0, 0, 0, 0, 0], c: [0, 0, 0, 0], tu: 0,
    lw: day - 1, // UTC day of the last PvP win (first win of the day → +20 XP, §6.3); not in the
                 // spec's §10.1 table but small (one int) and keeps the "first win today" bonus
                 // correct across reloads instead of only within one session.
  };
}
export function defaultProfile(day, uid = null) {
  return {
    v: SCHEMA_VERSION, rev: 0, uid, d0: day, day,
    w: 0, wd: 0, xd: [0, 0, 0, 0, 0, 0],
    rw: 0, gi: 0, wh: 0, lq: 0, av: 0,
    g: [0, 0, 0, 0, 0],
    sd: null, ly: null,
    st: [0, 0, 0],
    xp: 0,
    a: {},
    pg: null,
    f: [],
    fh: emptyFh(),
    fd: [day, 0],
    tu: 0,
    eq: {},
    seen: null, // null until first initialised (so upgrading users don't get a toast storm)
    pv: defaultPv(day),
  };
}

// Schema migrations, oldest first. (The v1.1 server import will use its own marker —
// `migrated:true` / v3 — since v2 is now the forecast schema.)
function migrate(data, day, uid) {
  if (!data || typeof data !== 'object') return null;
  let d = data;
  switch (d.v) {
    case 1: { // v1 → v2: forecasts, per-horizon counters, two more daily XP buckets
      const xd = [...(d.xd || [])];
      while (xd.length < 5) xd.push(0);
      d = { ...d, v: 2, xd, f: [], fh: emptyFh(), fd: [d.day ?? day, 0], tu: 0 };
    }
    // falls through
    case 2: {
      const base = defaultProfile(day, uid);
      const out = { ...base, ...d, xd: d.xd || base.xd, g: d.g || base.g, st: d.st || base.st, a: d.a || {} };
      out.f = Array.isArray(d.f) ? d.f.slice(0, HORIZON_COUNT) : [];
      out.fh = Array.isArray(d.fh) && d.fh.length === HORIZON_COUNT ? d.fh : emptyFh();
      out.fd = Array.isArray(d.fd) ? d.fd : base.fd;
      out.eq = d.eq && typeof d.eq === 'object' ? d.eq : {};
      out.seen = Array.isArray(d.seen) && d.seen.length === 2 ? d.seen : null;
      // xd grew a 6th slot (PvP daily XP) in v1.08; pad older profiles instead of truncating them.
      out.xd = Array.isArray(d.xd) ? [...d.xd.slice(0, 6), ...Array(Math.max(0, 6 - d.xd.length)).fill(0)] : base.xd;
      out.pv = d.pv && typeof d.pv === 'object' ? { ...base.pv, ...d.pv } : base.pv;
      return out;
    }
    default:
      return null; // unknown / future version: ignore rather than corrupt
  }
}

const maxOf = (a, b) => Math.max(a || 0, b || 0);

// Merge two profiles (§1.4). Never lowers a counter, never loses an achievement.
export function merge(local, cloud) {
  if (!cloud) return local;
  if (!local) return cloud;
  if (cloud.uid !== local.uid) return local;
  const newer = cloud.day > local.day || (cloud.day === local.day && cloud.rev > local.rev) ? cloud : local;
  const out = { ...newer };
  for (const k of ['w', 'rw', 'gi', 'wh', 'lq', 'av', 'xp']) out[k] = maxOf(local[k], cloud[k]);
  out.g = [...newer.g];
  for (const i of [0, 1, 3, 4]) out.g[i] = maxOf(local.g[i], cloud.g[i]);
  out.st = [...newer.st];
  out.st[1] = maxOf(local.st[1], cloud.st[1]);
  out.a = { ...local.a };
  for (const [id, day] of Object.entries(cloud.a || {})) out.a[id] = id in out.a ? Math.min(out.a[id], day) : day;
  // forecasts: active list + streaks from the newer copy (never resurrect a resolved one);
  // per-horizon made/won/best/void by max
  out.fh = (newer.fh || emptyFh()).map((row, h) => row.map((v, i) => (i === 2 ? v : maxOf(local.fh?.[h]?.[i], cloud.fh?.[h]?.[i]))));
  out.tu = maxOf(local.tu, cloud.tu);
  out.eq = { ...(newer.eq || {}) }; // equipment from the newer copy
  // PvP (PVP-SPEC.md §10.1): w[0..2]/w[4]/c by max; e = smaller energy after recomputing both
  // copies' regen to "now"; s/rs/r/w[3] from whichever copy has the larger rev.
  {
    const lp = local.pv || defaultPv(local.day);
    const cp = cloud.pv || defaultPv(cloud.day);
    const nowMs = Date.now();
    const recalcEnergy = (e) => {
      const [amt, at] = Array.isArray(e) ? e : [10, nowMs];
      const gained = Math.floor(Math.max(0, nowMs - at) / (6 * 60 * 1000));
      return Math.min(10, (amt || 0) + gained);
    };
    const pvNewer = (cloud.rev || 0) >= (local.rev || 0) ? cp : lp;
    const w = [...(pvNewer.w || defaultPv(0).w)];
    for (const i of [0, 1, 2, 4]) w[i] = maxOf(lp.w?.[i], cp.w?.[i]);
    w[3] = pvNewer.w?.[3] || 0;
    out.pv = {
      s: pvNewer.s || defaultPv(0).s,
      rs: pvNewer.rs ?? out.day,
      r: pvNewer.r ?? 1000,
      lw: pvNewer.lw ?? out.day - 1,
      w,
      c: (pvNewer.c || defaultPv(0).c).map((v, i) => maxOf(lp.c?.[i], cp.c?.[i])),
      tu: maxOf(lp.tu, cp.tu),
      e: [Math.min(recalcEnergy(lp.e), recalcEnergy(cp.e)), nowMs],
    };
  }
  if (local.seen || cloud.seen) {   // seen flags: union (BigInt masks stored as decimal strings)
    const a = local.seen || ['0', '0'];
    const b = cloud.seen || ['0', '0'];
    out.seen = [(BigInt(a[0] ?? 0) | BigInt(b[0] ?? 0)).toString(), (BigInt(a[1] ?? 0) | BigInt(b[1] ?? 0)).toString()];
  }
  out.d0 = Math.min(local.d0 ?? Infinity, cloud.d0 ?? Infinity);
  out.rev = maxOf(local.rev, cloud.rev);
  return out;
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function safeLocal(fn, fallback = null) {
  try { return fn(globalThis.localStorage); } catch { return fallback; }
}

// cloud: Telegram.WebApp.CloudStorage (or null). prefix: '' or 'test_' (?progtest=1).
export function createStore({ uid = null, prefix = '', cloud = null, now = () => Date.now() }) {
  const CLOUD_KEY = `${prefix}sb_prog_v1`;
  const LOCAL_KEY = `${prefix}sb.prog.v1.${uid ?? 'anon'}`;
  const LOCK_KEY = `${prefix}sb.prog.lock`;
  const tabId = Math.random().toString(36).slice(2, 10);
  const listeners = new Set();
  let cloudTimer = 0;
  let lastCloudWrite = 0;
  let cloudDirty = false;
  let cloudWrites = 0;

  const today = () => utcDayOf(now());
  const readLocal = () => safeLocal((ls) => JSON.parse(ls.getItem(LOCAL_KEY) || 'null'));
  let p = migrate(readLocal(), today(), uid) || defaultProfile(today(), uid);
  if (p.uid !== uid) p = defaultProfile(today(), uid);

  const emit = () => listeners.forEach((fn) => { try { fn(p); } catch (err) { console.error(err); } });

  // Only the leader tab writes; followers mirror what the leader stored (see lock below).
  function writeLocal() {
    if (!leader) return;
    safeLocal((ls) => ls.setItem(LOCAL_KEY, JSON.stringify(p)));
  }

  function writeCloud() {
    clearTimeout(cloudTimer);
    cloudTimer = 0;
    if (!cloud || !cloudDirty || !leader) return;
    const json = JSON.stringify(p);
    if (json.length > MAX_CLOUD_CHARS) {
      console.warn(`[progress] profile is ${json.length} chars; not writing to CloudStorage`);
      cloudDirty = false;
      return;
    }
    cloudDirty = false;
    lastCloudWrite = Date.now();
    cloudWrites++;
    try {
      cloud.setItem(CLOUD_KEY, json, (err) => {
        if (err) {
          cloudDirty = true;
          cloudTimer = setTimeout(writeCloud, CLOUD_RETRY_MS);
        }
      });
    } catch {
      cloudDirty = true;
      cloudTimer = setTimeout(writeCloud, CLOUD_RETRY_MS);
    }
  }

  // Local mirror is written synchronously on every change; the cloud write is trailing-
  // debounced so there is at most one CloudStorage.setItem per 5 s.
  function markDirty() {
    p.rev++;
    writeLocal();
    emit();
    cloudDirty = true;
    if (!cloud || cloudTimer) return;
    const wait = Math.max(0, lastCloudWrite + CLOUD_DEBOUNCE_MS - Date.now());
    cloudTimer = setTimeout(writeCloud, Math.max(wait, 50));
  }

  function flush() {
    writeLocal();
    if (cloudDirty) writeCloud();
  }

  // Async cloud load → merge. Resolves when done (or immediately without cloud).
  function loadCloud() {
    return new Promise((resolve) => {
      if (!cloud) return resolve();
      try {
        cloud.getItem(CLOUD_KEY, (err, value) => {
          if (!err && value) {
            let remote = null;
            try { remote = migrate(JSON.parse(value), today(), uid); } catch { /* corrupt */ }
            if (remote) {
              const merged = merge(p, remote);
              const changed = !same(merged, remote);
              p = merged;
              writeLocal();
              if (changed) markDirty();
              emit();
            }
          } else if (!err) {
            markDirty(); // nothing in the cloud yet: seed it
          }
          resolve();
        });
      } catch {
        resolve();
      }
    });
  }

  // ---------- multi-tab leader lock (§5.6) ----------
  function isLeader() {
    const lock = safeLocal((ls) => JSON.parse(ls.getItem(LOCK_KEY) || 'null'));
    const t = Date.now();
    if (!lock || lock.id === tabId || t - lock.at > LOCK_STALE_MS) {
      safeLocal((ls) => ls.setItem(LOCK_KEY, JSON.stringify({ id: tabId, at: t })));
      return true;
    }
    return false;
  }
  // Follower tabs re-read the leader's copy so a stale tab never overwrites newer progress,
  // and a tab that takes over the lock starts from the latest stored state.
  function syncFromLocal() {
    const stored = migrate(readLocal(), today(), uid);
    if (stored && stored.uid === uid) {
      p = merge(stored, p); // counters by max, day-scoped fields from the newer copy
      emit();
    }
  }
  let leader = isLeader();
  const lockTimer = setInterval(() => {
    const was = leader;
    leader = isLeader();
    if (!leader || !was) syncFromLocal();
  }, LOCK_EVERY_MS);

  return {
    get state() { return p; },
    get isLeader() { return leader; },
    get cloudWrites() { return cloudWrites; },
    keys: { CLOUD_KEY, LOCAL_KEY, LOCK_KEY },
    loadCloud,
    markDirty,
    flush,
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    emit,
    reset() {
      p = defaultProfile(today(), uid);
      markDirty();
      flush();
      emit();
    },
    release() {
      clearInterval(lockTimer);
      const lock = safeLocal((ls) => JSON.parse(ls.getItem(LOCK_KEY) || 'null'));
      if (lock?.id === tabId) safeLocal((ls) => ls.removeItem(LOCK_KEY));
    },
  };
}
