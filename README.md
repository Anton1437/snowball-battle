# Snowball Battle — BTC live

Live Bitcoin price as a pixel-art snowball fight: green-hat buyers vs red-hat sellers.

**Play:** [t.me/snowball_battle_bot/battle](https://t.me/snowball_battle_bot/battle) · web: [anton1437.github.io/snowball-battle](https://anton1437.github.io/snowball-battle/)
Static site: vanilla JS ES modules + Canvas 2D, no build step, no backend.

## Run locally

```sh
cd snowball-battle
python3 -m http.server 8080
# open http://localhost:8080
```

ES modules don't load from `file://`, so a local server is required.

URL parameters (for testing):

| Param | Effect |
|---|---|
| `?demo=1` | Force DEMO (simulated market), no sockets opened |
| `?fast=1` | Tiny ±$30 rounds, 2.5 s celebration, whales every 8–20 s |
| `?range=150` | Fixed half-range in $ (default: adaptive on live data — $100 until ~2 min of samples, then σ·√480 s clamped to $40–600; DEMO uses $150) |
| `?feeds=coinbase,bybit` | Only connect the listed feeds (`binance`, `bybit`, `coinbase`, `liquidations`; `none` → DEMO after 6 s) |
| `?delay=binance:5000` | Open a venue's socket late (tests a late joiner in AGG) |
| `?source=agg\|binance\|bybit\|coinbase` | Data source for this visit (overrides the saved menu choice) |
| `?lang=ru` / `?lang=en` | Force language for this visit (not persisted) |
| `?debug=1` | FPS / round / feed-status readout on the field |
| `?progtest=1` | Achievements/profile QA: tracking allowed together with test params, stored under `test_`-prefixed keys |

Console handle `__sb`: `__sb.market.debugBigprint('buy', 'giant')` (or `'big'`), `__sb.paused = true` + `__sb.step(seconds)`
to advance the scene deterministically, `__sb.forceActive = true` to let events reach the scene while the tab is hidden,
`__sb.market.debugCloseVenue('binance')` to kill a venue mid-run.

Scores are kept separately for live data and DEMO (`localStorage` keys `sb.score.v1` / `sb.score.demo.v1`).

Achievements & profile (v1.05, see `gamification/V105-CLIENT.md`): stored in Telegram CloudStorage
(`sb_prog_v1`, Bot API 6.9+) with a localStorage mirror (`sb.prog.v1.<uid>`). Nothing counts in DEMO or on
test links. QA console: `__sb.progress.state`, `.set({ gi: 24 })`, `.fakeDay(1)`, `.reset()`, `.flush()`.

## Data sources

| Venue | Stream | Used for |
|---|---|---|
| Binance spot | `wss://stream.binance.com:9443` (fallback `data-stream.binance.vision`): `btcusdt@aggTrade`, `@ticker`, `@depth20@100ms` | price, trades, 24h %, walls |
| Bybit spot | `wss://stream.bybit.com/v5/public/spot`: `publicTrade.BTCUSDT`, `orderbook.50.BTCUSDT`, `tickers.BTCUSDT` (ping every 20 s) | price, trades, 24h %, walls |
| Coinbase | `wss://ws-feed.exchange.coinbase.com`: `matches` + `ticker` BTC-USD | price, trades, 24h % |
| Binance USD-M | `wss://fstream.binance.com/ws/btcusdt@forceOrder` | liquidations |
| Bybit linear | `wss://stream.bybit.com/v5/public/linear`: `allLiquidation.BTCUSDT` | liquidations |

**Source modes** (tap the source badge → menu; saved in `localStorage`, `?source=` overrides):

- **AGG** (default, badge `AGG ·N` = live venues): price is the mean of venues that ticked in the last 5 s;
  trades / order flow / big prints from all venues (labelled Binance / Bybit / Coinbase); walls are the sum of the
  Binance depth20 and Bybit ob50 books within ±0.5% of mid; 24h % from Binance → Bybit → Coinbase.
  When a venue drops out or joins late, a correction offset keeps the price continuous and decays over ~30 s
  (USDT pairs and Coinbase USD differ by a few dollars), so the front line never jumps.
- **Binance / Bybit / Coinbase**: that venue only. If it goes down the app falls back to AGG and switches back
  once the venue has been stable for 2 s. Picking a source in the menu starts a fresh round (score unchanged).
- **DEMO**: only when no venue has produced a price for 6 s (labelled in the HUD). Returns to live automatically.

Some regions and networks block Binance or Bybit; any one reachable venue is enough.

Liquidation direction: Binance `forceOrder.S` is the *order* side (SELL = a long was liquidated), Bybit
`allLiquidation.S` is the *position* side (`Buy` = a long was liquidated). Both map to our convention
"long liquidated → hurts green".

Synthetic "whale" events fire every 40–120 s without a real big print and are never attributed to an exchange.

## Deploy (any static host)

The project root *is* the site — upload it as-is. HTTPS is required for Telegram.

- **GitHub Pages**: push the folder to a repo → Settings → Pages → Deploy from branch → `main` / root.
  URL: `https://<user>.github.io/<repo>/`
- **Netlify**: drag-and-drop the folder at app.netlify.com/drop, or connect the repo (build command: none, publish dir: `.`).
- **Vercel**: `New Project` → import repo → Framework preset "Other", no build command, output dir `.`.

## Releasing (cache-busting)

GitHub Pages serves files with `max-age=600` and Telegram WebViews cache hard, so a client could
mix old and new ES modules right after a deploy. **Run this before every release commit:**

```sh
python3 tools/release.py          # stamps ?v=<git short hash> into all relative imports + index.html
python3 tools/release.py --check  # exit 1 if anything is unstamped / stale (e.g. in a pre-push hook)
```

It is idempotent (an existing `?v=` is replaced) and stdlib-only. Local development does not need it:
unstamped imports work fine.

## Register as a Telegram Mini App

1. In Telegram open **@BotFather**, `/newbot` (if you don't have a bot yet) and note its username.
2. Option A — Mini App link: `/newapp` → pick the bot → title, description, 640×360 photo → **Web App URL** = your HTTPS URL → short name.
   Users open it via `https://t.me/<bot_username>/<short_name>`.
3. Option B — menu button: `/mybots` → bot → **Bot Settings → Menu Button → Configure menu button** → paste the URL and a label (e.g. "Play").
4. Optional: `/setdomain` isn't needed for Mini Apps; just make sure the URL is HTTPS and publicly reachable.

Inside Telegram the app calls `ready()`/`expand()`, disables vertical swipes (Bot API 7.7+), sets header/background colors,
uses the user's `language_code` for RU/EN and `HapticFeedback` for big prints and victories. In a normal browser all of that is skipped.

Note: some regions/networks block Binance or Bybit — AGG simply averages whatever venues are reachable, DEMO only if none are.

## Project layout

```
index.html, styles.css
src/main.js              wiring: market → round → scene/renderer → HUD, layout, loops
src/hud.js               DOM HUD (price, badge, pressure, score, walls, feed, banner, loading)
src/game/round.js        round state machine + price-axis levels (pure logic)
src/game/scene.js        kids, forts, giants, balls, FX, particles (simulation)
src/game/renderer.js     canvas renderer, 192×H logical, integer scaling, cached layers
src/game/sprites-cache.js  sprite baking (team colour swap) + mini font
src/game/camera.js       screen shake
src/market/              data layer (market.js orchestrator, binance/coinbase/liquidations/sim, flow, ws helper)
src/i18n.js, src/tg.js, src/audio.js
src/sprites.js, design/  art (designer)
```
