// Snowball Battle bot — Cloudflare Worker (Telegram webhook).
// Runs outside RU so Bot API calls are reliable. The only secret is BOT_TOKEN (Worker secret).
//   GET  /health  → ok
//   GET  /status  → webhook health (no secrets)
//   GET  /setup   → registers the webhook, commands, menu button and descriptions (idempotent)
//   POST /webhook → Telegram updates (verified by X-Telegram-Bot-Api-Secret-Token)

const WEBAPP_URL = 'https://anton1437.github.io/snowball-battle/';
const APP_LINK = 'https://t.me/snowball_battle_bot/battle';

const TEXT = {
  ru: {
    start: '❄️ <b>Снежная битва за биткоин!</b>\n\nЖивой курс BTC как пиксельная битва в снежки: зелёные шапки — покупатели, красные — продавцы, верёвка на поле — это цена. Крупные сделки кидает гигантский снеговик.\n\nУгадывай свечи, собирай ачивки и наряжай своего снеговичка. Жми «Играть» 👇',
    help: '📖 <b>Правила «Снежной битвы»</b>\n\n<b>Поле.</b> Живой курс BTC со всех бирж. Зелёные шапки — покупатели, красные — продавцы, верёвка — цена. Пробили диапазон раунда вверх — победа зелёных, вниз — красных. Крупные сделки кидает гигантский снеговик.\n\n<b>Прогнозы.</b> «Раунд» — угадай, кто пробьёт диапазон. «Время» — какой будет <i>следующая</i> свеча (1м…1д): зелёная или красная. Чем длиннее свеча, тем больше опыта.\n\n<b>Сторона дня.</b> За кого болеешь сегодня — бонус за верность, прогнозы это не ограничивает.\n\n<b>Дуэли.</b> Снежный бой с ботом: снежок целится сам, ты уворачиваешься (◀ ▶, «пригнуться») и зажимаешь «бросок» для силы. Энергия: 10 боёв, +1 каждые 6 минут.\n\n<b>Прогресс.</b> Опыт → уровни → ачивки и предметы гардероба для твоего снеговичка.\n\nВсё бесплатно. Звёзды — только косметика, силу не продаём.',
    paysupport: 'Вопросы по оплате: напишите сюда, мы ответим. Покупки за ⭐ — только косметика.',
    other: 'Игра открывается кнопкой ниже 👇',
    play: '❄️ Играть',
    rules: '📖 Правила',
    share: '📤 Позвать друга',
    shareText: 'Биткоин как битва в снежки — заходи!',
    short: 'Живой курс BTC как пиксельная битва в снежки ❄️',
    cmdStart: 'Открыть игру',
    cmdHelp: 'Правила игры',
  },
  en: {
    start: '❄️ <b>Snowball Battle for Bitcoin!</b>\n\nLive BTC price as a pixel-art snowball fight: green hats are buyers, red hats are sellers, the rope is the price. Big trades are thrown by a giant snowman.\n\nPredict candles, collect achievements and dress up your kid. Tap “Play” 👇',
    help: '📖 <b>Snowball Battle rules</b>\n\n<b>Field.</b> Live BTC price from all exchanges. Green hats are buyers, red hats are sellers, the rope is the price. Break the round range up and greens win, down and reds win. Big trades are thrown by a giant snowman.\n\n<b>Predictions.</b> “Round” — guess who breaks the range. “Time” — the colour of the <i>next</i> candle (1m…1d). Longer candles give more XP.\n\n<b>Side of the day.</b> Who you back today — a loyalty bonus; it never limits predictions.\n\n<b>Duels.</b> A snowball fight with a bot: throws aim themselves, you dodge (◀ ▶, duck) and hold “throw” for power. Energy: 10 fights, +1 every 6 minutes.\n\n<b>Progress.</b> XP → levels → achievements and wardrobe items for your kid.\n\nEverything is free. Stars buy cosmetics only — never power.',
    paysupport: 'Payment questions: write here and we will reply. ⭐ purchases are cosmetics only.',
    other: 'Open the game with the button below 👇',
    play: '❄️ Play',
    rules: '📖 Rules',
    share: '📤 Invite a friend',
    shareText: 'Bitcoin as a snowball fight — join in!',
    short: 'Live BTC price as a pixel snowball fight ❄️',
    cmdStart: 'Open the game',
    cmdHelp: 'Game rules',
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
  return {
    inline_keyboard: [
      [{ text: t.play, web_app: { url: WEBAPP_URL } }],
      [{ text: t.rules, callback_data: 'rules' }, { text: t.share, url: share }],
    ],
  };
}

async function handleUpdate(update, env) {
  const cq = update.callback_query;
  if (cq) {
    await tg(env, 'answerCallbackQuery', { callback_query_id: cq.id });
    if (cq.data === 'rules' && cq.message && cq.message.chat.type === 'private') {
      const t = TEXT[pickLang(cq.from && cq.from.language_code)];
      await tg(env, 'sendMessage', { chat_id: cq.message.chat.id, text: t.help, parse_mode: 'HTML', reply_markup: keyboard(t) });
    }
    return;
  }
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
  if (cmd === '/admin') {
    // Admin panel ships with the v1.1 server; until then just show the caller their own id
    // (needed for the owner whitelist). Harmless for anyone else: it's their own id.
    const ru = pickLang(msg.from && msg.from.language_code) === 'ru';
    const id = msg.from ? msg.from.id : '?';
    await tg(env, 'sendMessage', { chat_id: msg.chat.id, parse_mode: 'HTML',
      text: ru ? `🛠 Админка появится вместе с сервером (v1.1).\nВаш Telegram ID: <code>${id}</code>`
               : `🛠 The admin panel ships with the server (v1.1).\nYour Telegram ID: <code>${id}</code>` });
    return;
  }
  const text = cmd === '/start' ? t.start : (cmd === '/help' || cmd === '/rules') ? t.help : cmd === '/paysupport' ? t.paysupport : t.other;
  await tg(env, 'sendMessage', { chat_id: msg.chat.id, text, parse_mode: 'HTML', reply_markup: keyboard(t) });
}

async function setup(env, origin) {
  const secret = await webhookSecret(env.BOT_TOKEN);
  const out = {};
  out.webhook = await tg(env, 'setWebhook', {
    url: `${origin}/webhook`, secret_token: secret,
    allowed_updates: ['message', 'callback_query', 'pre_checkout_query'],
  });
  for (const lang of ['ru', 'en']) {
    const t = TEXT[lang];
    const scope = lang === 'ru' ? { language_code: 'ru' } : {};
    out[`commands_${lang}`] = await tg(env, 'setMyCommands', {
      commands: [{ command: 'start', description: t.cmdStart }, { command: 'rules', description: t.cmdHelp }], ...scope,
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
    if (url.pathname === '/status') {
      // Webhook health for monitoring; no secrets (the URL and error text only).
      const w = await tg(env, 'getWebhookInfo', {});
      const r = w.result || {};
      return Response.json({ ok: w.ok, url: r.url, allowed_updates: r.allowed_updates, pending: r.pending_update_count,
        last_error: r.last_error_message || null, last_error_date: r.last_error_date || null });
    }
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
