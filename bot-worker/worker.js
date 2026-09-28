// Snowball Battle bot — Cloudflare Worker (Telegram webhook).
// Runs outside RU so Bot API calls are reliable. The only secret is BOT_TOKEN (Worker secret).
//   GET  /health  → ok
//   GET  /setup   → registers the webhook, commands, menu button and descriptions (idempotent)
//   POST /webhook → Telegram updates (verified by X-Telegram-Bot-Api-Secret-Token)

const WEBAPP_URL = 'https://anton1437.github.io/snowball-battle/';
const APP_LINK = 'https://t.me/snowball_battle_bot/battle';

const TEXT = {
  ru: {
    start: '❄️ <b>Снежная битва за биткоин!</b>\n\nЖивой курс BTC как пиксельная битва в снежки: зелёные шапки — покупатели, красные — продавцы, верёвка на поле — это цена. Крупные сделки кидает гигантский снеговик.\n\nУгадывай свечи, собирай ачивки и наряжай своего снеговичка. Жми «Играть» 👇',
    help: '<b>Как играть</b>\n• Поле показывает живую цену BTC: зелёные давят вверх, красные вниз.\n• Прогноз раунда — кто пробьёт диапазон цены.\n• Прогноз на время — какой будет следующая свеча (1м…1д).\n• Дуэли — снежный бой с ботом.\n\nВсё бесплатно. Снежки нельзя купить или вывести.',
    paysupport: 'Вопросы по оплате: напишите сюда, мы ответим. Покупки за ⭐ — только косметика.',
    other: 'Игра открывается кнопкой ниже 👇',
    play: '❄️ Играть',
    share: '📤 Позвать друга',
    shareText: 'Биткоин как битва в снежки — заходи!',
    short: 'Живой курс BTC как пиксельная битва в снежки ❄️',
    cmdStart: 'Открыть игру',
    cmdHelp: 'Как играть',
  },
  en: {
    start: '❄️ <b>Snowball Battle for Bitcoin!</b>\n\nLive BTC price as a pixel-art snowball fight: green hats are buyers, red hats are sellers, the rope is the price. Big trades are thrown by a giant snowman.\n\nPredict candles, collect achievements and dress up your kid. Tap “Play” 👇',
    help: '<b>How to play</b>\n• The field shows the live BTC price: greens push up, reds push down.\n• Round prediction — who breaks the price range.\n• Timed prediction — the colour of the next candle (1m…1d).\n• Duels — a snowball fight with a bot.\n\nEverything is free. Snowballs can’t be bought or cashed out.',
    paysupport: 'Payment questions: write here and we will reply. ⭐ purchases are cosmetics only.',
    other: 'Open the game with the button below 👇',
    play: '❄️ Play',
    share: '📤 Invite a friend',
    shareText: 'Bitcoin as a snowball fight — join in!',
    short: 'Live BTC price as a pixel snowball fight ❄️',
    cmdStart: 'Open the game',
    cmdHelp: 'How to play',
  },
};

const RU_LANGS = new Set(['ru', 'uk', 'be', 'kk', 'uz', 'ky', 'tg', 'hy', 'az', 'ka']);
const pickLang = (code) => (RU_LANGS.has(String(code || '').slice(0, 2)) ? 'ru' : 'en');

// Webhook secret derived from the bot token, so no extra secret has to be configured.
async function webhookSecret(token) {
  const data = new TextEncoder().encode(`snowball-webhook:${token}`);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 48);
}

async function tg(env, method, body) {
  const res = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

function keyboard(t) {
  const share = `https://t.me/share/url?url=${encodeURIComponent(APP_LINK)}&text=${encodeURIComponent(t.shareText)}`;
  return { inline_keyboard: [[{ text: t.play, web_app: { url: WEBAPP_URL } }], [{ text: t.share, url: share }]] };
}

async function handleUpdate(update, env) {
  const msg = update.message;
  if (update.pre_checkout_query) {
    // No shop yet: decline politely. Replace when the Stars shop ships (answer within 10 s).
    await tg(env, 'answerPreCheckoutQuery', {
      pre_checkout_query_id: update.pre_checkout_query.id, ok: false,
      error_message: 'Магазин скоро откроется / The shop opens soon',
    });
    return;
  }
  if (!msg || !msg.chat || msg.chat.type !== 'private') return;
  const t = TEXT[pickLang(msg.from && msg.from.language_code)];
  const cmd = String(msg.text || '').split(/[\s@]/)[0];
  const text = cmd === '/start' ? t.start : cmd === '/help' ? t.help : cmd === '/paysupport' ? t.paysupport : t.other;
  await tg(env, 'sendMessage', { chat_id: msg.chat.id, text, parse_mode: 'HTML', reply_markup: keyboard(t) });
}

async function setup(env, origin) {
  const secret = await webhookSecret(env.BOT_TOKEN);
  const out = {};
  out.webhook = await tg(env, 'setWebhook', {
    url: `${origin}/webhook`, secret_token: secret,
    allowed_updates: ['message', 'pre_checkout_query'],
  });
  for (const lang of ['ru', 'en']) {
    const t = TEXT[lang];
    const scope = lang === 'ru' ? { language_code: 'ru' } : {};
    out[`commands_${lang}`] = await tg(env, 'setMyCommands', {
      commands: [{ command: 'start', description: t.cmdStart }, { command: 'help', description: t.cmdHelp }], ...scope,
    });
    out[`short_${lang}`] = await tg(env, 'setMyShortDescription', { short_description: t.short, ...scope });
  }
  out.menu = await tg(env, 'setChatMenuButton', {
    menu_button: { type: 'web_app', text: 'Играть', web_app: { url: WEBAPP_URL } },
  });
  // Only report ok/description — never echo anything token-related.
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, { ok: v.ok, description: v.description }]));
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (url.pathname === '/health') return new Response('ok');
    if (!env.BOT_TOKEN) return new Response('BOT_TOKEN secret is not set', { status: 500 });
    if (url.pathname === '/setup') {
      return Response.json(await setup(env, url.origin));
    }
    if (url.pathname === '/webhook' && req.method === 'POST') {
      if (req.headers.get('X-Telegram-Bot-Api-Secret-Token') !== (await webhookSecret(env.BOT_TOKEN))) {
        return new Response('forbidden', { status: 403 });
      }
      const update = await req.json();
      ctx.waitUntil(handleUpdate(update, env).catch(() => {}));
      return new Response('ok');
    }
    return new Response('not found', { status: 404 });
  },
};
