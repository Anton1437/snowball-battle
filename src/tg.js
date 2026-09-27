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

export function telegramLanguage() {
  return webApp?.initDataUnsafe?.user?.language_code ?? null;
}

// Telegram's colour scheme ('light'|'dark') or null outside Telegram.
export function telegramColorScheme() {
  return isTelegram ? webApp.colorScheme : null;
}
