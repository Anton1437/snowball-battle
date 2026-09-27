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
| `?feeds=coinbase,liquidations` | Only connect the listed live feeds (`binance`, `coinbase`, `liquidations`; `none` → DEMO after 6 s) |
| `?lang=ru` / `?lang=en` | Force language for this visit (not persisted) |
| `?debug=1` | FPS / round / feed-status readout on the field |

Console handle `__sb`: `__sb.market.debugBigprint('buy', 'giant')` (or `'big'`), `__sb.paused = true` + `__sb.step(seconds)`
to advance the scene deterministically, `__sb.forceActive = true` to let events reach the scene while the tab is hidden.

Scores are kept separately for live data and DEMO (`localStorage` keys `sb.score.v1` / `sb.score.demo.v1`).

## Data sources

1. Binance spot `btcusdt@aggTrade`, `@ticker`, `@depth20@100ms` (fallback host `data-stream.binance.vision`).
2. Coinbase `ws-feed.exchange.coinbase.com` `matches` + `ticker` (used for price if Binance is down).
3. Binance futures `btcusdt@forceOrder` liquidations (best effort).
4. If no live price arrives within ~6 s → **DEMO** mode (labelled in the HUD). Switches back automatically when a live feed recovers.

Synthetic "whale" events fire every 40–120 s without a real big print and are never attributed to an exchange.

## Deploy (any static host)

The project root *is* the site — upload it as-is. HTTPS is required for Telegram.

- **GitHub Pages**: push the folder to a repo → Settings → Pages → Deploy from branch → `main` / root.
  URL: `https://<user>.github.io/<repo>/`
- **Netlify**: drag-and-drop the folder at app.netlify.com/drop, or connect the repo (build command: none, publish dir: `.`).
- **Vercel**: `New Project` → import repo → Framework preset "Other", no build command, output dir `.`.

## Register as a Telegram Mini App

1. In Telegram open **@BotFather**, `/newbot` (if you don't have a bot yet) and note its username.
2. Option A — Mini App link: `/newapp` → pick the bot → title, description, 640×360 photo → **Web App URL** = your HTTPS URL → short name.
   Users open it via `https://t.me/<bot_username>/<short_name>`.
3. Option B — menu button: `/mybots` → bot → **Bot Settings → Menu Button → Configure menu button** → paste the URL and a label (e.g. "Play").
4. Optional: `/setdomain` isn't needed for Mini Apps; just make sure the URL is HTTPS and publicly reachable.

Inside Telegram the app calls `ready()`/`expand()`, disables vertical swipes (Bot API 7.7+), sets header/background colors,
uses the user's `language_code` for RU/EN and `HapticFeedback` for big prints and victories. In a normal browser all of that is skipped.

Note: some regions/networks block Binance endpoints — the app then falls back to Coinbase, then to DEMO.

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
