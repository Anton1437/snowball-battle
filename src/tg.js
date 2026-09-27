// Telegram Mini App wrapper. Every call is a safe no-op outside Telegram.
// telegram-web-app.js defines window.Telegram.WebApp even in a normal browser (platform 'unknown'),
// and warns on unsupported calls — so we gate on platform and version.

const webApp = globalThis.Telegram?.WebApp;
export const isTelegram = !!webApp && webApp.platform && webApp.platform !== 'unknown';

const supports = (version) => {
  try { return isTelegram && webApp.isVersionAtLeast(version); } catch { return false; }
};

const HAPTIC_MIN_GAP_MS = 60;
let lastHaptic = 0;

export function initTelegram({ headerColor, backgroundColor } = {}) {
  if (!isTelegram) return;
  try {
    webApp.ready();
    webApp.expand();
    if (supports('7.7')) webApp.disableVerticalSwipes();
    if (headerColor && supports('6.1')) webApp.setHeaderColor(headerColor);
    if (backgroundColor && supports('6.1')) webApp.setBackgroundColor(backgroundColor);
    if (supports('7.10') && backgroundColor) webApp.setBottomBarColor?.(backgroundColor);
    document.documentElement.classList.add('in-telegram');
  } catch (err) {
    console.warn('[tg] init failed', err);
  }
}

// level: 'light' | 'medium' | 'heavy' | 'rigid' | 'soft'
export function haptic(level = 'light') {
  if (!supports('6.1')) return;
  const now = performance.now();
  if (now - lastHaptic < HAPTIC_MIN_GAP_MS) return;
  lastHaptic = now;
  try { webApp.HapticFeedback.impactOccurred(level); } catch { /* ignore */ }
}

// type: 'success' | 'warning' | 'error'
export function notify(type = 'success') {
  if (!supports('6.1')) return;
  try { webApp.HapticFeedback.notificationOccurred(type); } catch { /* ignore */ }
}

// Light tick for picking an option (menus, selectors).
export function hapticSelection() {
  if (!supports('6.1')) return;
  try { webApp.HapticFeedback.selectionChanged(); } catch { /* ignore */ }
}

// Bot API 8.0+: whether the Mini App is active (not minimised). Always true elsewhere.
export function isAppActive() {
  if (!supports('8.0')) return true;
  return webApp.isActive !== false;
}

export function onAppActiveChange(fn) {
  if (!supports('8.0')) return;
  try {
    webApp.onEvent('activated', () => fn(true));
    webApp.onEvent('deactivated', () => fn(false));
  } catch { /* ignore */ }
}

// Telegram BackButton (6.1+): show while a sheet is open; handler closes it.
export function backButton(show, onClick) {
  if (!supports('6.1')) return;
  try {
    const bb = webApp.BackButton;
    if (show) {
      bb.onClick(onClick);
      bb.show();
    } else {
      bb.offClick(onClick);
      bb.hide();
    }
  } catch { /* ignore */ }
}

// CloudStorage (Bot API 6.9+) or null.
export function cloudStorage() {
  return supports('6.9') ? webApp.CloudStorage : null;
}

export function telegramUser() {
  return webApp?.initDataUnsafe?.user ?? null;
}

export function telegramLanguage() {
  return webApp?.initDataUnsafe?.user?.language_code ?? null;
}

// Telegram's colour scheme ('light'|'dark') or null outside Telegram.
export function telegramColorScheme() {
  return isTelegram ? webApp.colorScheme : null;
}
