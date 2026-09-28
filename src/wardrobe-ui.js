// v1.07 "My kid + wardrobe" UI: the kid card (big animated avatar, level/XP/streak, side of
// the day, try-on toggle) and the wardrobe (5 slots, one item each, "none" allowed), plus the
// look controller that feeds the field renderer and raises "new item" toasts.
//
// Interactive elements are built ONCE and updated in place (never rebuilt on a timer — iOS
// swallows taps on nodes replaced mid-gesture).
import { t, getLang } from './i18n.js?v=c67d170d';
import { spriteDataUrl, makeCanvas, UI } from './game/sprites-cache.js?v=c67d170d';
import { ACHIEVEMENTS, levelOf } from './progress/achievements.js?v=c67d170d';
import {
  ITEMS, SLOTS, SLOT_KEY, byId, isUnlocked, unlockedMask, buildLook, avatarViewOf, avatarSpriteName,
  trailColors, frameColors, LOOK_IDS, isLookUnlocked, lookReq, lookItemIds,
} from './cosmetics.js?v=c67d170d';
import { drawKidLook } from './game/kid-art.js?v=c67d170d';
import * as ART from './sprites.js?v=c67d170d';

// Avatar canvas (logical px): room for a crown above the hat, and (v1.08) for a pet standing
// 12 px to the right of the kid's feet and a back item's hem below it.
const AV_W = 28;
const AV_H = 30;
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

// Requirement tag under a locked cell (DESIGN.md §11): "УР. 10" / "LV 10", the achievement
// name, or (v1.08 premium items/looks, §12) the shop star.
export function reqTag(item) {
  if (item.unlock.premium) return t('wr.premiumTag');
  if (item.unlock.level) return t('wr.lvTag', { n: item.unlock.level });
  return ACH_IDS.has(item.unlock.ach) ? achName(item.unlock.ach) : item.unlock.ach;
}

export function lockText(item) {
  if (item.unlock.premium) return t('wr.premium');
  if (item.unlock.level) return t('wr.lockLevel', { n: item.unlock.level });
  return t('wr.lockAch', { a: ACH_IDS.has(item.unlock.ach) ? achName(item.unlock.ach) : item.unlock.ach });
}

// Same tag/status text for a curated look (LOOKS[id]).
export function lookReqTag(id) {
  const look = ART.LOOKS[id];
  if (look.tier === 'premium') return t('wr.premiumTag');
  const req = lookReq(id);
  if (!req) return '';
  if (req.level) return t('wr.lvTag', { n: req.level });
  return ACH_IDS.has(req.ach) ? achName(req.ach) : req.ach;
}

export function lookLockText(id) {
  const look = ART.LOOKS[id];
  if (look.tier === 'premium') return t('wr.premium');
  const req = lookReq(id);
  if (!req) return '';
  if (req.level) return t('wr.lockLevel', { n: req.level });
  return t('wr.lockAch', { a: ACH_IDS.has(req.ach) ? achName(req.ach) : req.ach });
}

// ---------- item previews (cached data URLs; locked = slate bake per DESIGN.md §10) ----------
// Green faces the viewer in the beanie here (DESIGN.md §11 v1.08): kid_front_beanie_* instead
// of the back view. Never used on the battlefield — field rendering keeps kid_back_* for green.
const previewCache = new Map();
export function itemPreviewUrl(item, team, locked) {
  const key = `${item ? item.id : 'none'}|${team}|${locked}`;
  if (previewCache.has(key)) return previewCache.get(key);
  const c = makeCanvas(AV_W, AV_H);
  const g = c.getContext('2d');
  const view = avatarViewOf(team);
  const look = buildLook(item ? { [SLOT_KEY[item.slot]]: item.id } : {}, team, null, { view });
  drawKidLook(g, avatarSpriteName(team, 'idle'), team, 0, AV_FEET[0], AV_FEET[1], look);
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

// A curated LOOKS[id] bundle, shown on the wardrobe cell regardless of lock (matches
// itemPreviewUrl's pattern; the caller recolours to slate for a locked look).
const lookPreviewCache = new Map();
export function lookPreviewUrl(id, team) {
  const key = `${id}|${team}`;
  if (lookPreviewCache.has(key)) return lookPreviewCache.get(key);
  const look = ART.LOOKS[id];
  const eq = {};
  for (const itemId of lookItemIds(look)) {
    const it = byId[itemId];
    if (it) eq[SLOT_KEY[it.slot]] = itemId;
  }
  const c = makeCanvas(AV_W, AV_H);
  const g = c.getContext('2d');
  const view = avatarViewOf(team);
  const built = buildLook(eq, team, null, { view });
  drawKidLook(g, avatarSpriteName(team, 'idle'), team, 0, AV_FEET[0], AV_FEET[1], built);
  const url = c.toDataURL('image/png');
  lookPreviewCache.set(key, url);
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
  // v1.08 (DESIGN.md §12): premium items/looks are TRIED ON in the profile preview only — an
  // overlay on top of the real equip, never persisted, never sent to the field renderer.
  let preview = null; // { eq: {...}, ids: Set<string> } | null

  // Upgrading users: everything already unlocked counts as notified (no toast storm);
  // the profile dot still shows until the wardrobe is opened.
  // seen[0]/seen[1] are BigInt masks (ITEMS is past 32 entries) stored as decimal strings —
  // BigInt() reads both a legacy small number and the new string the same way. Re-checked (not
  // just on first load) so a runtime profile reset — e.g. the __sb.progress.reset() QA helper —
  // never leaves it null.
  function ensureSeen(q) {
    if (Array.isArray(q.seen)) return;
    q.seen = [unlockedMask(q).toString(), '0'];
    store.markDirty();
  }
  ensureSeen(p());

  function refresh() {
    const q = p();
    ensureSeen(q);
    const mask = unlockedMask(q);
    const team = myTeam();
    const key = `${team}|${JSON.stringify(q.eq || {})}|${mask}`;
    if (key !== lastKey) {
      lastKey = key;
      onLook?.(buildLook(q.eq, team, q), team);
    }
    const fresh = mask & ~BigInt(q.seen[0] ?? 0);
    if (fresh) {
      q.seen[0] = (BigInt(q.seen[0] ?? 0) | fresh).toString();
      store.markDirty();
      ITEMS.forEach((it, i) => { if (fresh & (1n << BigInt(i))) toast?.(it); });
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
    preview = null; // a real equip supersedes any try-on preview
    refresh();
    return true;
  }

  // Equips every item a free, unlocked look bundles (DESIGN.md §12: "grants its items"). Fails
  // (no-op) for a premium look or one still locked — use setPreview for those instead.
  function equipLook(id) {
    const look = ART.LOOKS?.[id];
    if (!look || look.tier !== 'free' || !isLookUnlocked(id, p())) return false;
    let any = false;
    for (const itemId of lookItemIds(look)) {
      const it = byId[itemId];
      if (it && equip(it.slot, it.id)) any = true;
    }
    return any;
  }

  // Try-on preview (premium items/looks): `eqPatch` is a partial { [slotKey]: itemId } overlaid
  // on the real equip for the avatar only. Pass null to clear it.
  function setPreview(eqPatch) {
    preview = eqPatch && Object.keys(eqPatch).length ? { eq: eqPatch, ids: new Set(Object.values(eqPatch)) } : null;
    listeners.forEach((fn) => fn());
    avatars.forEach((c) => drawAvatar(c));
  }

  function markViewed() {
    const q = p();
    ensureSeen(q);
    const mask = unlockedMask(q);
    const seen1 = BigInt(q.seen[1] ?? 0);
    if ((seen1 & mask) !== mask) {
      q.seen[1] = (seen1 | mask).toString();
      store.markDirty();
      listeners.forEach((fn) => fn());
    }
  }

  const hasUnseen = () => { ensureSeen(p()); return (unlockedMask(p()) & ~BigInt(p().seen[1] ?? 0)) !== 0n; };

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

  // Green faces the viewer in the beanie (DESIGN.md §11 v1.08): the profile avatar uses
  // kid_front_beanie_* instead of the back view. Never on the battlefield.
  function drawAvatar(canvas) {
    const team = tryTeam || myTeam();
    const g = canvas.getContext('2d');
    g.clearRect(0, 0, AV_W, AV_H);
    drawKidLook(g, avatarSpriteName(team, 'idle'), team, frame, AV_FEET[0], AV_FEET[1], buildLookCached(team), performance.now() / 1000);
  }

  const lookCache = new Map();
  function buildLookCached(team) {
    const q = p();
    const view = avatarViewOf(team);
    const eq = preview ? { ...(q.eq || {}), ...preview.eq } : q.eq;
    const key = `${team}|${view}|${JSON.stringify(eq || {})}|${unlockedMask(q)}`;
    let lk = lookCache.get(key);
    if (!lk) {
      if (lookCache.size > 16) lookCache.clear();
      lk = buildLook(eq, team, q, { view, extraIds: preview?.ids });
      lookCache.set(key, lk);
    }
    return lk;
  }

  return {
    refresh,
    equip,
    equipLook,
    setPreview,
    get preview() { return preview; },
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

  // «Образы» / Looks: one tap equips a whole free bundle; premium looks are try-on only.
  const looksBox = el('div', 'wr-slot wr-looks');
  const looksLabel = el('div', 'wr-slot-name');
  const looksItems = el('div', 'wr-items');
  looksItems.setAttribute('role', 'radiogroup');
  looksBox.append(looksLabel, looksItems);
  root.append(looksBox);
  const lookButtons = LOOK_IDS.map((id) => {
    const b = el('button', 'wr-item wr-look');
    b.type = 'button';
    b.dataset.look = id;
    const thumb = el('span', 'wr-thumb');
    const img = new Image();
    img.className = 'px-icon';
    img.alt = '';
    thumb.append(img);
    b.append(thumb, el('span', 'wr-name'), el('span', 'wr-req'));
    looksItems.append(b);
    return { b, id };
  });

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

  let statusText = ''; // '' = nothing tapped yet (show the hint)
  root.addEventListener('click', (e) => {
    const lb = e.target.closest('.wr-look');
    if (lb) {
      const id = lb.dataset.look;
      const look = ART.LOOKS[id];
      const name = getLang() === 'ru' ? look.name_ru : look.name_en;
      if (look.tier === 'premium') {
        const eq = {};
        for (const itemId of lookItemIds(look)) { const it = byId[itemId]; if (it) eq[SLOT_KEY[it.slot]] = itemId; }
        cosmetics.setPreview(eq);
        statusText = `${name} · ${lookLockText(id)}`;
      } else if (isLookUnlocked(id, store.state)) {
        cosmetics.setPreview(null);
        if (cosmetics.equipLook(id)) { onEquip?.(); statusText = t('wr.equipped', { name }); }
      } else {
        cosmetics.setPreview(null);
        statusText = `${name} · ${lookLockText(id)}`;
      }
      update();
      return;
    }
    const b = e.target.closest('.wr-item');
    if (!b) return;
    const slot = b.parentElement.dataset.slot;
    const it = byId[b.dataset.id] || null;
    const name = it ? t(`item.${it.id}`) : t('wr.none');
    if (!it || isUnlocked(it, store.state)) {
      cosmetics.setPreview(null);
      if (cosmetics.equip(slot, it ? it.id : null)) { onEquip?.(); statusText = t('wr.equipped', { name }); }
    } else if (it.unlock.premium) {
      cosmetics.setPreview({ [SLOT_KEY[slot]]: it.id });
      statusText = `${name} · ${lockText(it)}`;
    } else {
      cosmetics.setPreview(null);
      statusText = `${name} · ${lockText(it)}`;
    }
    update();
  });

  function itemName(it) { return it ? t(`item.${it.id}`) : t('wr.none'); }

  function update() {
    const q = store.state;
    const team = cosmetics.tryTeam;
    head.textContent = t('wr.title');
    looksLabel.textContent = t('slot.looks');
    looksItems.setAttribute('aria-label', t('slot.looks'));
    for (const { b, id } of lookButtons) {
      const look = ART.LOOKS[id];
      const premium = look.tier === 'premium';
      const unlocked = !premium && isLookUnlocked(id, q);
      const previewing = cosmetics.preview && lookItemIds(look).every((iid) => Object.values(cosmetics.preview.eq).includes(iid));
      b.classList.toggle('locked', !unlocked);
      b.classList.toggle('premium', premium);
      b.classList.toggle('on', previewing || (unlocked && lookItemIds(look).every((iid) => {
        const it = byId[iid];
        return !it || (q.eq || {})[SLOT_KEY[it.slot]] === iid;
      })));
      b.setAttribute('aria-disabled', String(!unlocked && !premium));
      const nm = getLang() === 'ru' ? look.name_ru : look.name_en;
      const nameEl = b.querySelector('.wr-name');
      if (nameEl.textContent !== nm) nameEl.textContent = nm;
      const req = b.querySelector('.wr-req');
      const rq = unlocked ? '' : lookReqTag(id);
      if (req.textContent !== rq) req.textContent = rq;
      req.hidden = unlocked;
      const img = b.querySelector('img');
      const src = lookPreviewUrl(id, team);
      if (img.src !== src) img.src = src;
      const title = `${nm}${unlocked ? '' : ` · ${lookLockText(id)}`}`;
      if (b.title !== title) { b.title = title; b.setAttribute('aria-label', title); }
    }
    for (const slot of SLOTS) {
      const { label, items, buttons } = slotEls[slot];
      label.textContent = t(`slot.${slot}`);
      items.setAttribute('aria-label', t(`slot.${slot}`));
      const equipped = q.eq?.[SLOT_KEY[slot]] || '';
      const previewedId = cosmetics.preview?.eq?.[SLOT_KEY[slot]];
      for (const { b, it } of buttons) {
        const unlocked = !it || isUnlocked(it, q);
        const on = (it ? it.id : '') === equipped && previewedId == null;
        const previewing = it && previewedId === it.id;
        b.classList.toggle('locked', !unlocked);
        b.classList.toggle('premium', !!it?.unlock.premium);
        b.classList.toggle('on', on);
        b.classList.toggle('previewing', previewing);
        b.setAttribute('aria-checked', String(on));
        b.setAttribute('aria-disabled', String(!unlocked && !it?.unlock.premium));
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
    status.textContent = statusText || t('wr.hint');
    shop.textContent = t('wr.shop');
  }

  cosmetics.onChange(update);
  return { el: root, update };
}
