// RU/EN strings. Detection: saved choice → Telegram language_code → navigator.language.
// DOM: elements with data-i18n="key" get their textContent replaced by applyDom().

const LANG_KEY = 'sb.lang';
const RU_FAMILY = ['ru', 'uk', 'be', 'kk', 'uz', 'ky', 'tg', 'hy', 'az'];

const DICT = {
  en: {
    title: 'Snowball Battle',
    'src.BINANCE': 'BINANCE',
    'src.COINBASE': 'COINBASE',
    'src.DEMO': 'DEMO',
    'src.connecting': 'CONNECTING',
    'demo.hint': 'Live feeds unavailable — simulated market',
    'change.suffix': '24H',
    'pressure.buy': 'BUY',
    'pressure.sell': 'SELL',
    'pressure.aria': 'Order flow: {buy}% buying, {sell}% selling',
    'score.aria': 'Rounds won: green {g}, red {r}',
    'walls.title': 'BOOK ±0.5%',
    'walls.bid': 'Buy wall',
    'walls.ask': 'Sell wall',
    'sound.on': 'Sound on',
    'sound.off': 'Sound off',
    'lang.toggle': 'RU',
    'lang.aria': 'Switch language to Russian',
    'feed.title': 'MARKET FEED',
    'feed.empty': 'Waiting for big prints…',
    'feed.bigBuy': '{ex} · buy',
    'feed.bigSell': '{ex} · sell',
    'feed.giantBuy': '{ex} · MEGA buy',
    'feed.giantSell': '{ex} · MEGA sell',
    'feed.demoBuy': 'Big buy',
    'feed.demoSell': 'Big sell',
    'feed.demoGiantBuy': 'MEGA buy',
    'feed.demoGiantSell': 'MEGA sell',
    'feed.liqLong': 'Longs liquidated · {ex}',
    'feed.liqShort': 'Shorts liquidated · {ex}',
    'feed.whaleBuy': 'Whale · buy',
    'feed.whaleSell': 'Whale · sell',
    'feed.greenWins': 'GREEN · round {n}',
    'feed.redWins': 'RED · round {n}',
    'feed.source': 'Source: {src}',
    'banner.greenWins': 'GREEN WINS!',
    'banner.redWins': 'RED WINS!',
    'banner.round': 'ROUND {n}',
    'side.title': 'SNOWBALL BATTLE',
    'side.subtitle': 'BTC/USD live',
    'legend.title': 'HOW IT WORKS',
    'legend.green': 'Green hats: buyers',
    'legend.red': 'Red hats: sellers',
    'legend.line': 'The rope is the price (average across exchanges). Up: green pushes, down: red pushes',
    'legend.ball': 'Big snowball: trade of $250K+',
    'legend.giant': 'Giant snowman: trade of $1M+ or liquidation of $100K+',
    'legend.whale': 'Whale: random event, not a real trade',
    'legend.win': 'Price leaves the round range: that team wins',
    'feed.expand': 'Show more',
    'src.AGG': 'AGG',
    'src.BYBIT': 'BYBIT',
    'menu.title': 'Data source',
    'menu.agg': 'All exchanges (average)',
    'menu.live': '{n} live',
    'menu.offline': 'offline',
    'menu.settings': 'Settings',
    'menu.sound': 'Sound',
    'menu.lang': 'Language',
    'menu.langName': 'English',
    'menu.on': 'ON',
    'menu.off': 'OFF',
    'menu.close': 'Close',
    'menu.open': 'Choose data source',
    'venues.title': 'EXCHANGES',
    loading: 'LOADING',
  },
  ru: {
    title: 'Снежная битва',
    'src.BINANCE': 'BINANCE',
    'src.COINBASE': 'COINBASE',
    'src.DEMO': 'ДЕМО',
    'src.connecting': 'ПОДКЛЮЧЕНИЕ',
    'demo.hint': 'Живые данные недоступны — симуляция рынка',
    'change.suffix': '24Ч',
    'pressure.buy': 'ПОКУПКИ',
    'pressure.sell': 'ПРОДАЖИ',
    'pressure.aria': 'Поток ордеров: покупки {buy}%, продажи {sell}%',
    'score.aria': 'Выиграно раундов: зелёные {g}, красные {r}',
    'walls.title': 'СТАКАН ±0.5%',
    'walls.bid': 'Стена покупок',
    'walls.ask': 'Стена продаж',
    'sound.on': 'Звук включён',
    'sound.off': 'Звук выключен',
    'lang.toggle': 'EN',
    'lang.aria': 'Switch language to English',
    'feed.title': 'ЛЕНТА РЫНКА',
    'feed.empty': 'Ждём крупные сделки…',
    'feed.bigBuy': '{ex} · покупка',
    'feed.bigSell': '{ex} · продажа',
    'feed.giantBuy': '{ex} · МЕГА-покупка',
    'feed.giantSell': '{ex} · МЕГА-продажа',
    'feed.demoBuy': 'Крупная покупка',
    'feed.demoSell': 'Крупная продажа',
    'feed.demoGiantBuy': 'МЕГА-покупка',
    'feed.demoGiantSell': 'МЕГА-продажа',
    'feed.liqLong': 'Ликвидация лонгов · {ex}',
    'feed.liqShort': 'Ликвидация шортов · {ex}',
    'feed.whaleBuy': 'Кит · покупка',
    'feed.whaleSell': 'Кит · продажа',
    'feed.greenWins': 'ЗЕЛЁНЫЕ · раунд {n}',
    'feed.redWins': 'КРАСНЫЕ · раунд {n}',
    'feed.source': 'Источник: {src}',
    'banner.greenWins': 'ЗЕЛЁНЫЕ ПОБЕДИЛИ!',
    'banner.redWins': 'КРАСНЫЕ ПОБЕДИЛИ!',
    'banner.round': 'РАУНД {n}',
    'side.title': 'СНЕЖНАЯ БИТВА',
    'side.subtitle': 'BTC/USD в реальном времени',
    'legend.title': 'КАК ЭТО РАБОТАЕТ',
    'legend.green': 'Зелёные шапки: покупатели',
    'legend.red': 'Красные шапки: продавцы',
    'legend.line': 'Верёвка — это цена (среднее по биржам). Вверх давят зелёные, вниз — красные',
    'legend.ball': 'Большой снежок: сделка от $250K',
    'legend.giant': 'Снеговик-великан: сделка от $1M или ликвидация от $100K',
    'legend.whale': 'Кит: случайное событие, не реальная сделка',
    'legend.win': 'Цена вышла за диапазон раунда: команда побеждает',
    'feed.expand': 'Показать больше',
    'src.AGG': 'ВСЕ',
    'src.BYBIT': 'BYBIT',
    'menu.title': 'Источник данных',
    'menu.agg': 'Все биржи (среднее)',
    'menu.live': 'в сети: {n}',
    'menu.offline': 'нет связи',
    'menu.settings': 'Настройки',
    'menu.sound': 'Звук',
    'menu.lang': 'Язык',
    'menu.langName': 'Русский',
    'menu.on': 'ВКЛ',
    'menu.off': 'ВЫКЛ',
    'menu.close': 'Закрыть',
    'menu.open': 'Выбрать источник данных',
    'venues.title': 'БИРЖИ',
    loading: 'ЗАГРУЗКА',
  },
};

const listeners = new Set();
let lang = detectLang();

function readSaved() {
  try { return localStorage.getItem(LANG_KEY); } catch { return null; }
}

function normalize(code) {
  const base = String(code || '').toLowerCase().split(/[-_]/)[0];
  return RU_FAMILY.includes(base) ? 'ru' : 'en';
}

export function detectLang() {
  const saved = readSaved();
  if (saved && DICT[saved]) return saved;
  const tgCode = globalThis.Telegram?.WebApp?.initDataUnsafe?.user?.language_code;
  if (tgCode) return normalize(tgCode);
  return normalize(globalThis.navigator?.language);
}

export const getLang = () => lang;

export function setLang(next, { persist = true } = {}) {
  if (!DICT[next] || next === lang) return;
  lang = next;
  if (persist) {
    try { localStorage.setItem(LANG_KEY, next); } catch { /* ignore */ }
  }
  document.documentElement.lang = lang;
  listeners.forEach((fn) => fn(lang));
}

export const toggleLang = () => setLang(lang === 'ru' ? 'en' : 'ru');

export function onLangChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function t(key, params) {
  const s = DICT[lang][key] ?? DICT.en[key] ?? key;
  return params ? s.replace(/\{(\w+)\}/g, (_, k) => (params[k] ?? '')) : s;
}

export function applyDom(root = document) {
  document.documentElement.lang = lang;
  root.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t(el.dataset.i18n); });
  root.querySelectorAll('[data-i18n-aria]').forEach((el) => el.setAttribute('aria-label', t(el.dataset.i18nAria)));
}

// ---------- number formatting ----------
const THIN = '\u2009';

// HUD price: integer with thin-space thousands separators, e.g. "67 245".
export function formatPrice(p) {
  if (!(p > 0)) return '—';
  return Math.round(p).toString().replace(/\B(?=(\d{3})+(?!\d))/g, THIN);
}

// Feed / banner price with a $ sign: "$67 245".
export const formatPriceUsd = (p) => (p > 0 ? `$${formatPrice(p)}` : '—');

// Compact USD: $850, $12.4K, $1.25M (same in both languages — reads fine in a pixel font).
export function formatUsd(usd) {
  const a = Math.abs(usd);
  if (a >= 1e9) return `$${(a / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `$${(a / 1e6).toFixed(a >= 1e7 ? 1 : 2)}M`;
  if (a >= 1e3) return `$${(a / 1e3).toFixed(a >= 1e5 ? 0 : 1)}K`;
  return `$${Math.round(a)}`;
}

// Always signed ("+1.24%" / "-0.87%"); ASCII minus because Press Start 2P lacks U+2212.
export function formatChange(pct) {
  if (!Number.isFinite(pct)) return '';
  return `${pct >= 0 ? '+' : '-'}${Math.abs(pct).toFixed(2)}%`;
}
