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

export function defaultProfile(day, uid = null) {
  return {
    v: 1, rev: 0, uid, d0: day, day,
    w: 0, wd: 0, xd: [0, 0, 0],
    rw: 0, gi: 0, wh: 0, lq: 0, av: 0,
    g: [0, 0, 0, 0, 0],
    sd: null, ly: null,
    st: [0, 0, 0],
    xp: 0,
    a: {},
    pg: null,
  };
}

// Schema migrations live here (v1.1 will set v:2 + migrated:true and stop local tracking).
function migrate(data, day, uid) {
  if (!data || typeof data !== 'object') return null;
  switch (data.v) {
    case 1: {
      const base = defaultProfile(day, uid);
      return { ...base, ...data, xd: data.xd || base.xd, g: data.g || base.g, st: data.st || base.st, a: data.a || {} };
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
