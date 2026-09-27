// v1.07 "My kid + wardrobe" UI: the kid card (big animated avatar, level/XP/streak, side of
// the day, try-on toggle) and the wardrobe (5 slots, one item each, "none" allowed), plus the
// look controller that feeds the field renderer and raises "new item" toasts.
//
// Interactive elements are built ONCE and updated in place (never rebuilt on a timer — iOS
// swallows taps on nodes replaced mid-gesture).
import { t } from './i18n.js?v=6ee7c4dd';
import { spriteDataUrl, makeCanvas, UI } from './game/sprites-cache.js?v=6ee7c4dd';
import { ACHIEVEMENTS, levelOf } from './progress/achievements.js?v=6ee7c4dd';
import {
  ITEMS, SLOTS, SLOT_KEY, byId, isUnlocked, unlockedMask, buildLook, viewOf, trailColors, frameColors,
} from './cosmetics.js?v=6ee7c4dd';
import { drawKidLook } from './game/kid-art.js?v=6ee7c4dd';

const AV_W = 20;            // avatar canvas (logical px): room for a crown above the hat
const AV_H = 26;
const AV_FEET = [10, 25];
const ANIM_MS = 500;        // idle anim at 2 fps
const achName = (id) => t(`ach.${id}.name`);
const ACH_IDS = new Set(ACHIEVEMENTS.map((a) => a.id));

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

// Requirement tag under a locked cell (DESIGN.md §11): "УР. 10" / "LV 10" or the achievement name.
export function reqTag(item) {
  if (item.unlock.level) return t('wr.lvTag', { n: item.unlock.level });
  return ACH_IDS.has(item.unlock.ach) ? achName(item.unlock.ach) : item.unlock.ach;
}

export function lockText(item) {
  if (item.unlock.level) return t('wr.lockLevel', { n: item.unlock.level });
  return t('wr.lockAch', { a: ACH_IDS.has(item.unlock.ach) ? achName(item.unlock.ach) : item.unlock.ach });
}

// ---------- item previews (cached data URLs; locked = slate bake per DESIGN.md §10) ----------
const previewCache = new Map();
export function itemPreviewUrl(item, team, locked) {
  const key = `${item ? item.id : 'none'}|${team}|${locked}`;
  if (previewCache.has(key)) return previewCache.get(key);
  const c = makeCanvas(AV_W, AV_H);
  const g = c.getContext('2d');
  const look = buildLook(item ? { [SLOT_KEY[item.slot]]: item.id } : {}, team, null);
  drawKidLook(g, `kid_${viewOf(team)}_idle`, team, 0, AV_FEET[0], AV_FEET[1], look);
  if (locked) {
    const img = g.getImageData(0, 0, AV_W, AV_H);
    const d = img.data;
    const [lr, lg, lb] = [1, 3, 5].map((i) => parseInt((UI.achLocked || '#5d6f9e').slice(i, i + 2), 16));
    for (let i = 0; i < d.length; i += 4) {
      if (!d[i + 3]) continue;
      if (d[i] === 0x1a && d[i + 1] === 0x1c && d[i + 2] === 0x2c) continue; // keep the k outline
      d[i] = lr; d[i + 1] = lg; d[i + 2] = lb;
    }
    g.putImageData(img, 0, 0);
  }
  const url = c.toDataURL('image/png');
  previewCache.set(key, url);
  return url;
}

// ---------- look controller ----------
export function createCosmetics({ store, tracker, onLook, toast }) {
  let tryTeam = null;          // preview-only team for the avatar ("Примерить")
  let lastKey = '';
  const avatars = new Set();   // canvases to animate
  const listeners = new Set();
  const p = () => store.state;
  const myTeam = () => (tracker.sideState().picked === 'r' ? 'red' : 'green');

  // Upgrading users: everything already unlocked counts as notified (no toast storm);
  // the profile dot still shows until the wardrobe is opened.
  if (!Array.isArray(p().seen)) {
    p().seen = [unlockedMask(p()), 0];
    store.markDirty();
  }

  function refresh() {
    const q = p();
    const mask = unlockedMask(q);
    const team = myTeam();
    const key = `${team}|${JSON.stringify(q.eq || {})}|${mask}`;
    if (key !== lastKey) {
      lastKey = key;
      onLook?.(buildLook(q.eq, team, q), team);
    }
    const fresh = mask & ~q.seen[0];
    if (fresh) {
      q.seen[0] |= fresh;
      store.markDirty();
      ITEMS.forEach((it, i) => { if (fresh & (1 << i)) toast?.(it); });
    }
    paintFrames();
    listeners.forEach((fn) => fn());
  }

  function equip(slot, id) {
    const q = p();
    const k = SLOT_KEY[slot];
    q.eq = { ...(q.eq || {}) };
    if (!id) delete q.eq[k];
    else {
      const it = byId[id];
      if (!it || it.slot !== slot || !isUnlocked(it, q)) return false;
      q.eq[k] = id;
    }
    store.markDirty();
    refresh();
    return true;
  }

  function markViewed() {
    const q = p();
    const mask = unlockedMask(q);
    if ((q.seen[1] & mask) !== mask) {
      q.seen[1] |= mask;
      store.markDirty();
      listeners.forEach((fn) => fn());
    }
  }

  const hasUnseen = () => (unlockedMask(p()) & ~p().seen[1]) !== 0;

  // profile frame ring (DESIGN.md §11): ring [0] 4 px, inner [1] 2 px, top highlight [2] 2 px;
  // frame_aurora rotates its 3 colours ring → inner → highlight every 400 ms.
  const frameBoxes = new Set();
  let auroraStep = 0;
  function paintFrames() {
    const it = byId[p().eq?.f];
    const cols = it && isUnlocked(it, p()) ? frameColors(it.id) : null;
    const rot = it?.id === 'frame_aurora' ? auroraStep % 3 : 0;
    for (const box of frameBoxes) {
      box.classList.toggle('framed', !!cols);
      if (!cols) continue;
      box.style.setProperty('--frame-a', cols[rot % cols.length]);
      box.style.setProperty('--frame-b', cols[(rot + 1) % cols.length]);
      box.style.setProperty('--frame-c', cols[(rot + 2) % cols.length]);
    }
  }
  setInterval(() => {
    if (document.hidden || p().eq?.f !== 'frame_aurora' || !frameBoxes.size) return;
    auroraStep++;
    paintFrames();
  }, 400);

  // avatar animation: redraw registered canvases only (no DOM churn)
  let frame = 0;
  setInterval(() => {
    if (document.hidden || !avatars.size) return;
    frame ^= 1;
    for (const c of avatars) if (c.isConnected && c.offsetParent) drawAvatar(c);
  }, ANIM_MS);

  function drawAvatar(canvas) {
    const team = tryTeam || myTeam();
    const g = canvas.getContext('2d');
    g.clearRect(0, 0, AV_W, AV_H);
    drawKidLook(g, `kid_${viewOf(team)}_idle`, team, frame, AV_FEET[0], AV_FEET[1], buildLookCached(team));
  }

  const lookCache = new Map();
  function buildLookCached(team) {
    const q = p();
    const key = `${team}|${JSON.stringify(q.eq || {})}|${unlockedMask(q)}`;
    let lk = lookCache.get(key);
    if (!lk) {
      if (lookCache.size > 16) lookCache.clear();
      lk = buildLook(q.eq, team, q);
      lookCache.set(key, lk);
    }
    return lk;
  }

  return {
    refresh,
    equip,
    markViewed,
    hasUnseen,
    myTeam,
    get tryTeam() { return tryTeam || myTeam(); },
    setTryTeam(team) { tryTeam = team; listeners.forEach((fn) => fn()); avatars.forEach((c) => drawAvatar(c)); },
    registerAvatar(c) { avatars.add(c); drawAvatar(c); },
    registerFrameBox(box) { frameBoxes.add(box); paintFrames(); },
    paintFrames,
    drawAvatar,
    frameColors() {
      const it = byId[p().eq?.f];
      return it && isUnlocked(it, p()) ? frameColors(it.id) : null;
    },
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  };
}

// ---------- kid card (profile header) ----------
export function createKidCard({ store, tracker, cosmetics, userName, onPickSide }) {
  const root = el('div', 'kid-card read');
  const top = el('div', 'prof-top');
  const avBox = el('div', 'avatar-box');
  const canvas = document.createElement('canvas');
  canvas.width = AV_W;
  canvas.height = AV_H;
  canvas.className = 'avatar';
  const lvlTag = el('span', 'lvl-tag');
  avBox.append(canvas, lvlTag);
  const info = el('div', 'prof-info');
  const name = el('div', 'prof-name');
  const xpbar = el('div', 'xpbar');
  const xpfill = el('i');
  xpbar.append(xpfill);
  const xpRow = el('div', 'prof-row');
  const xpTxt = el('span', 'xp-txt num');
  const streak = el('span', 'streak');
  const icicle = new Image();
  icicle.className = 'px-icon';
  icicle.alt = '';
  icicle.src = spriteDataUrl('ach_icicle', 'green', 2);
  const streakTxt = el('span');
  streak.append(icicle, streakTxt);
  xpRow.append(xpTxt, streak);
  const sideLine = el('div', 'side-line');
  const note = el('div', 'prof-note');
  const hint = el('div', 'side-hint');
  info.append(name, xpbar, xpRow, sideLine, note, hint);
  top.append(avBox, info);

  const trySeg = el('div', 'seg try-seg');
  trySeg.setAttribute('role', 'group');
  const tryLabel = el('span', 'try-label');
  const tryG = el('button', 'seg-btn');
  tryG.type = 'button';
  tryG.dataset.try = 'green';
  const tryR = el('button', 'seg-btn');
  tryR.type = 'button';
  tryR.dataset.try = 'red';
  trySeg.append(tryLabel, tryG, tryR);

  const pick = el('div', 'side-pick');
  const pickLabel = el('span', 'side-pick-label');
  const pickG = el('button', 'gbtn g');
  pickG.type = 'button';
  pickG.dataset.pick = 'g';
  const pickR = el('button', 'gbtn r');
  pickR.type = 'button';
  pickR.dataset.pick = 'r';
  pick.append(pickLabel, pickG, pickR);

  root.append(top, trySeg, pick);
  cosmetics.registerAvatar(canvas);
  cosmetics.registerFrameBox(avBox);

  trySeg.addEventListener('click', (e) => {
    const b = e.target.closest('[data-try]');
    if (b) cosmetics.setTryTeam(b.dataset.try === cosmetics.myTeam() ? null : b.dataset.try);
  });
  pick.addEventListener('click', (e) => {
    const b = e.target.closest('[data-pick]');
    if (b) onPickSide(b.dataset.pick);
  });

  function update(until) {
    const q = store.state;
    const lv = levelOf(q.xp);
    const side = tracker.sideState();
    const set = (node, txt) => { if (node.textContent !== txt) node.textContent = txt; };
    set(name, userName || t('prof.guest'));
    set(lvlTag, String(lv.level));
    lvlTag.setAttribute('aria-label', t('prof.level', { n: lv.level }));
    xpfill.style.width = `${Math.round((lv.into / lv.need) * 100)}%`;
    set(xpTxt, `${t('prof.level', { n: lv.level })} · ${t('prof.xp', { a: lv.into, b: lv.need })}`);
    set(streakTxt, t('prof.streak', { n: q.st[0] }));
    const sideTxt = side.picked === 'g' ? t('prof.backGreen') : side.picked === 'r' ? t('prof.backRed') : t('prof.sideNone');
    sideLine.innerHTML = `${t('prof.side')}: <b class="side-${side.picked || 'none'}">${sideTxt}</b>${side.picked && until
      ? ` · ${t('prof.sideNext', { h: until.h, m: until.m })}` : ''}`;
    set(note, t('prof.sideNote'));
    hint.hidden = !!side.picked;
    set(hint, t('prof.pickSideHint'));
    pick.hidden = !!side.picked;
    set(pickLabel, t('prof.sidePick'));
    pickG.innerHTML = `<i class="tri up" aria-hidden="true"></i>${t('side.green')}`;
    pickR.innerHTML = `<i class="tri down" aria-hidden="true"></i>${t('side.red')}`;
    // try-on toggle
    const tt = cosmetics.tryTeam;
    set(tryLabel, t('wr.try'));
    set(tryG, t('wr.tryGreen'));
    set(tryR, t('wr.tryRed'));
    tryG.setAttribute('aria-pressed', String(tt === 'green'));
    tryR.setAttribute('aria-pressed', String(tt === 'red'));
    cosmetics.drawAvatar(canvas);
  }

  return { el: root, update };
}

// ---------- wardrobe ----------
export function createWardrobe({ store, cosmetics, onEquip }) {
  const root = el('section', 'wardrobe read');
  const head = el('h3', 'menu-sub');
  root.append(head);
  const slotEls = {};
  for (const slot of SLOTS) {
    const box = el('div', 'wr-slot');
    const label = el('div', 'wr-slot-name');
    const items = el('div', 'wr-items');
    items.setAttribute('role', 'radiogroup');
    items.dataset.slot = slot;
    const buttons = [];
    for (const it of [null, ...ITEMS.filter((i) => i.slot === slot)]) {
      const b = el('button', 'wr-item');
      b.type = 'button';
      b.setAttribute('role', 'radio');
      b.dataset.id = it ? it.id : '';
      const thumb = el('span', 'wr-thumb');
      if (slot === 'trail' || slot === 'frame') {
        thumb.append(el('span', `wr-swatch ${slot}`));
      } else {
        const img = new Image();
        img.className = 'px-icon';
        img.alt = '';
        thumb.append(img);
      }
      b.append(thumb, el('span', 'wr-name'), el('span', 'wr-req'));
      items.append(b);
      buttons.push({ b, it });
    }
    box.append(label, items);
    root.append(box);
    slotEls[slot] = { label, items, buttons };
  }
  const status = el('div', 'wr-status');
  status.setAttribute('aria-live', 'polite');
  const shop = el('div', 'wr-shop');
  shop.setAttribute('aria-disabled', 'true');
  root.append(status, shop);

  let statusItem; // undefined = nothing tapped yet (show the hint)
  root.addEventListener('click', (e) => {
    const b = e.target.closest('.wr-item');
    if (!b) return;
    const slot = b.parentElement.dataset.slot;
    const it = byId[b.dataset.id] || null;
    statusItem = it;
    if (!it || isUnlocked(it, store.state)) {
      if (cosmetics.equip(slot, it ? it.id : null)) onEquip?.();
    }
    update();
  });

  function itemName(it) { return it ? t(`item.${it.id}`) : t('wr.none'); }

  function update() {
    const q = store.state;
    const team = cosmetics.tryTeam;
    head.textContent = t('wr.title');
    for (const slot of SLOTS) {
      const { label, items, buttons } = slotEls[slot];
      label.textContent = t(`slot.${slot}`);
      items.setAttribute('aria-label', t(`slot.${slot}`));
      const equipped = q.eq?.[SLOT_KEY[slot]] || '';
      for (const { b, it } of buttons) {
        const unlocked = !it || isUnlocked(it, q);
        const on = (it ? it.id : '') === equipped;
        b.classList.toggle('locked', !unlocked);
        b.classList.toggle('on', on);
        b.setAttribute('aria-checked', String(on));
        b.setAttribute('aria-disabled', String(!unlocked));
        const title = `${itemName(it)}${unlocked ? '' : ` · ${lockText(it)}`}`;
        if (b.title !== title) {
          b.title = title;
          b.setAttribute('aria-label', title);
        }
        const nameEl = b.querySelector('.wr-name');
        const nm = itemName(it);
        if (nameEl.textContent !== nm) nameEl.textContent = nm;
        const req = b.querySelector('.wr-req');
        const rq = unlocked ? '' : reqTag(it);
        if (req.textContent !== rq) req.textContent = rq;
        req.hidden = unlocked;
        const img = b.querySelector('img');
        if (img) {
          const src = itemPreviewUrl(it, team, !unlocked);
          if (img.src !== src) img.src = src;
        } else {
          const sw = b.querySelector('.wr-swatch');
          const cols = it ? (slot === 'trail' ? trailColors(it.id) : frameColors(it.id)) : null;
          sw.style.setProperty('--c1', cols ? (unlocked ? cols[0] : '#5d6f9e') : 'transparent');
          sw.style.setProperty('--c2', cols ? (unlocked ? cols[1] || cols[0] : '#3b4468') : 'transparent');
          sw.style.setProperty('--c3', cols ? (unlocked ? cols[2] || cols[0] : '#5d6f9e') : 'transparent');
          sw.classList.toggle('empty', !it);
        }
      }
    }
    const it = statusItem;
    status.textContent = it === undefined ? t('wr.hint')
      : !it || isUnlocked(it, q) ? t('wr.equipped', { name: itemName(it) }) : `${itemName(it)} · ${lockText(it)}`;
    shop.textContent = t('wr.shop');
  }

  cosmetics.onChange(update);
  return { el: root, update };
}
