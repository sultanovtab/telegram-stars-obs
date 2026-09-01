# PROJECT_CONTEXT.md — starchik / Telegram Stars → OBS

**Project snapshot:** `v5.1.0`  
**Snapshot date:** `2026-09-02`  
**Bot username:** `@ttt_stars_bot`  
**Brand name:** `starchik`  
**GitHub repository:** `https://github.com/sultanovtab/telegram-stars-obs`  
**Cloudflare Worker name:** `telegram-stars-obs`  
**Production workers.dev origin used in this project:** `https://telegram-stars-obs.sultanov-tab.workers.dev`  

> **Important source-of-truth note:** the latest code package prepared for this project is **v5.1.0**. At the time of this snapshot, the public GitHub `main` page still displayed the older **v4** README / 4 commits. Therefore, a new developer or ChatGPT must **not assume that GitHub already contains v5.1**. First inspect `package.json`; the intended current version must say `"version": "5.1.0"`. If GitHub still contains v4, use the user's saved v5.1 project ZIP/repository copy as the latest source and reconcile it with `main` before making new changes.

> **Security rule:** this document intentionally contains **no real secret values** and **no real OBS overlay key**. Never ask the user to paste `BOT_TOKEN`, webhook secret, claim secret, setup secret, or OBS key into a public repository or ordinary chat unless absolutely necessary. Prefer Cloudflare runtime Secrets.

---

## 1. Project purpose

`starchik` is a custom donation/alert system for a streamer. Viewers support the stream using **Telegram Stars**. After Telegram confirms a real payment, the bot sends a realtime event to an OBS Browser Source, which shows a donation alert containing the viewer name, Stars amount, optional comment, animation, sound, and optional TTS.

The project deliberately replaces a traditional third-party donation-alert provider with a small self-hosted stack built on Telegram + Cloudflare.

Primary goals:

- accept Telegram Stars safely through the official Bot API;
- never display a real donation alert before `successful_payment`;
- allow the streamer to configure most behavior from Telegram `/admin` instead of editing code;
- keep OBS realtime via WebSockets;
- keep infrastructure simple and inexpensive enough for a small/starting streamer while leaving reasonable room for growth;
- preserve durable payment/history/config state across Worker deployments.

---

## 2. Current architecture

High-level data flow:

```text
Viewer
  │
  │ Telegram private chat / inline buttons / Stars invoice
  ▼
Telegram Bot API
  │
  │ HTTPS webhook POST /telegram
  ▼
Cloudflare Worker (router / security boundary)
  │
  │ HUB binding → one named Durable Object instance
  ▼
StreamHub Durable Object: "starchik-main"
  │
  ├─ SQLite-backed Durable Object storage
  │    ├─ config
  │    ├─ orders
  │    ├─ payments
  │    ├─ payment history
  │    ├─ admin ID / user flow state
  │    └─ balance cache / dedupe state
  │
  ├─ Telegram Bot API outbound calls
  │
  └─ Hibernating WebSockets
        │
        ├─ mode=alerts ──► OBS alert Browser Source
        └─ mode=goal   ──► OBS Stars-goal Browser Source
```

Media path:

```text
Admin uploads GIF / video / sticker / audio / voice to Telegram
  → bot stores Telegram file_id + MIME metadata in config
  → OBS requests /media/{animation|sound}/{tier}?key=<OBS_KEY>
  → Worker/DO resolves Telegram file and proxies bytes to OBS
```

Static UI path:

```text
/overlay/landscape or /overlay/vertical
  → Worker preserves query parameters
  → serves public/overlay.html through ASSETS binding

/goal/landscape or /goal/vertical
  → Worker preserves query parameters
  → serves public/goal.html through ASSETS binding
```

---

## 3. Technologies used

### Telegram

- Telegram Bot API
- Telegram Stars / currency `XTR`
- `sendInvoice`
- `pre_checkout_query`
- direct webhook response with `answerPreCheckoutQuery`
- `successful_payment`
- `telegram_payment_charge_id`
- `getMyStarBalance`
- `refundStarPayment`
- `refunded_payment`
- `getFile` + Telegram file download API for alert media
- inline keyboards / callback queries

### Cloudflare

- Cloudflare Workers
- Cloudflare Durable Objects
- **SQLite-backed Durable Object storage**
- Durable Object Storage API (`get`, `put`, `delete`, `list`, `transaction`)
- WebSocket Hibernation API
- `setWebSocketAutoResponse()` for `ping` → `pong`
- Workers Static Assets via `ASSETS` binding
- runtime Variables and Secrets
- GitHub-connected automatic deployment
- Wrangler `4.127.1` pinned in `package.json`

### OBS / browser

- OBS Browser Source
- HTML/CSS/JavaScript overlays
- WebSockets
- browser `localStorage` for reconnect cursor
- Web Speech API / `SpeechSynthesisUtterance` for current TTS
- HTML5 `Audio`, `img`, and `video` for sound/animation playback

### Development / testing

- JavaScript ES modules
- Node.js built-in test runner (`node --test`)
- Wrangler CLI
- source/static integration tests

No React, framework, database server, or separate backend server is currently used.

---

## 4. Current project file structure

Expected v5.1 structure:

```text
telegram-stars-obs/
├─ .gitignore
├─ README.md
├─ package.json
├─ wrangler.jsonc
│
├─ src/
│  ├─ index.js
│  ├─ v4-logic.js
│  ├─ overlay-route.js
│  ├─ update-dedupe.js
│  └─ payment-receipt.js
│
├─ public/
│  ├─ index.html
│  ├─ overlay.html
│  ├─ overlay-logic.js
│  └─ goal.html
│
└─ tests/
   ├─ goal-route.test.mjs
   ├─ overlay-route.test.mjs
   ├─ overlay-v4.test.mjs
   ├─ payment-hardening.test.mjs
   ├─ payment-receipt-dedupe.test.mjs
   ├─ runtime-hardening-source.test.mjs
   ├─ secret-store-compat.test.mjs
   ├─ update-dedupe.test.mjs
   ├─ v4-integration-source.test.mjs
   └─ v4-logic.test.mjs
```

### `src/index.js`

Main Worker + Durable Object implementation.

Responsibilities:

- top-level Worker routing;
- `/health`;
- `/bootstrap`;
- webhook secret validation;
- forwarding Telegram updates to the Durable Object;
- overlay/goal static asset routing;
- `StreamHub` Durable Object class;
- Telegram commands and callback handlers;
- admin UI logic;
- donation flow;
- media configuration;
- invoice creation;
- payment/refund processing;
- payment history;
- Stars balance and goal state;
- WebSocket connection/dispatch;
- OBS link generation.

Important functions/classes include:

```text
resolveSecret()
resolveSecretWithFallback()
tg()
getTelegramFile()
mainMenu()
adminMenu()
mediaFromMessage()

fetch()                         // top-level Worker
StreamHub                       // Durable Object
StreamHub.config()
StreamHub.handleTelegram()
StreamHub.handleMessage()
StreamHub.handleCallback()
StreamHub.handleWebSocket()
StreamHub.handleMedia()
StreamHub.getStarBalance()
StreamHub.getGoalState()
StreamHub.broadcastGoal()
StreamHub.beginDonation()
StreamHub.askComment()
StreamHub.offerTtsOrInvoice()
StreamHub.createInvoice()
StreamHub.handlePreCheckout()
StreamHub.handleSuccessfulPayment()
StreamHub.handleRefundedPayment()
StreamHub.refundPaymentByPayload()
StreamHub.emitAlert()
StreamHub.sendObsLinks()
StreamHub.sendGoalLinks()
```

### `src/v4-logic.js`

Pure business logic / validation functions retained under the historical filename `v4-logic.js`.

Contains:

- default TTS profiles;
- default goal settings;
- config normalization/migration;
- TTS profile filtering;
- base amount + TTS fee pricing;
- animation tier selection;
- goal progress math;
- single Telegram Stars `LabeledPrice` construction;
- pre-checkout validation;
- successful-payment validation;
- direct `answerPreCheckoutQuery` webhook body;
- monotonic alert sequence;
- refunded-payment validation.

### `src/update-dedupe.js`

v5.1 duplicate-webhook protection for **ordinary** Telegram updates.

- stable fingerprint:
  - `callback:<callback_query_id>`
  - `message:<chat_id>:<message_id>`
  - fallback `update:<update_id>`
- atomically reserves update fingerprint in a Durable Object transaction **before ordinary bot side effects**;
- keeps a bounded recent dedupe list;
- recognizes legacy `processedUpdates` during migration;
- deliberately does **not** early-reserve payment-critical updates (`pre_checkout_query`, `successful_payment`, `refunded_payment`).

### `src/payment-receipt.js`

Deduplicates the user-facing “Stars received / thank you” Telegram message across concurrent `successful_payment` retries.

Functions:

```text
claimPaymentReceipt()
completePaymentReceipt()
failPaymentReceipt()
```

### `src/overlay-route.js`

Rewrites friendly OBS routes to static asset files while preserving all query parameters, especially `key`, `debug`, `preview`, and `tts`.

### `public/overlay.html`

OBS donation alert overlay.

Responsibilities:

- alert WebSocket connection;
- reconnect with exponential backoff;
- local reconnect cursor (`lastSeenSeq`);
- client-side event-ID dedupe;
- sequential alert queue;
- animation/image/video display;
- sound playback;
- TTS via Speech Synthesis;
- adaptive time on screen based on comment length;
- wait for TTS completion before hiding;
- debug / preview modes.

### `public/overlay-logic.js`

Pure timing helpers:

- `estimateVisibleMs(text, tierMinimumMs)`
- `ttsTimeoutMs(text)`

### `public/goal.html`

OBS Stars donation-goal widget.

- progress bar;
- goal title;
- current balance / target;
- goal WebSocket;
- fallback `/goal-state` refresh approximately every 120 seconds;
- debug and preview mode.

### `public/index.html`

Simple landing page pointing users to the Telegram bot.

### `tests/*`

Tests cover payment validation, refund validation, WebSocket hardening patterns, overlay routes, reconnect sequence behavior, TTS timing/error behavior, goal flow, secret compatibility, duplicate webhook suppression, payment receipt dedupe, and source-level hardening assumptions.

At this snapshot, the v5.1 archive was locally verified with:

```text
npm test      → 48/48 tests passing
npm run check → JavaScript syntax checks passing
```

---

## 5. Current user-facing features

### Telegram Stars payments

- preset Stars amounts;
- custom Stars amount;
- currency `XTR`;
- payment accepted through Telegram invoice;
- alert created only after verified `successful_payment`;
- full-payment refund support for eligible recent payments.

Default preset amounts:

```text
10 / 25 / 50 / 100 / 250 / 500 / 1000 ⭐
```

Allowed custom amount in current code:

```text
1–10000 ⭐
```

Admin can replace preset amount list with 2–12 custom preset values.

### Comments

- optional viewer comment;
- max current length: `140` characters;
- “Без комментария” shortcut;
- displayed safely using DOM `textContent`, not injected HTML.

### Animation tiers

Default tiers:

| Tier | Stars | Default minimum display time |
|---|---:|---:|
| 0 | 1–24 | 6000 ms |
| 1 | 25–99 | 6500 ms |
| 2 | 100–249 | 7000 ms |
| 3 | 250–499 | 7500 ms |
| 4 | 500–999 | 8500 ms |
| 5 | 1000+ | 10000 ms |

Admin may assign one animation/media asset per tier.

Supported animation uploads include:

- Telegram animation/GIF;
- WebM/MP4/video;
- image/photo;
- ordinary static sticker;
- Telegram video sticker;
- image/video document.

Current limitation: **TGS animated stickers are not supported**.

### Sounds

Admin may assign one sound per tier.

Supported inputs include:

- Telegram audio;
- voice message;
- audio document.

### OBS alerts

Alert shows:

- viewer username/name;
- total Stars paid;
- comment;
- TTS badge when applicable;
- tier animation or fallback ⭐;
- tier sound;
- test/real indicator.

### Telegram admin panel

The owner controls the streamer-facing configuration directly inside Telegram. Details are listed in section 15.

### TTS / message reading

Current TTS engine is **browser/OBS Speech Synthesis**, not a Cloudflare/server-generated MP3 service.

Viewer flow:

- a comment is required for TTS;
- viewer can choose one of the currently enabled TTS profiles;
- TTS fee is added to the Telegram invoice total;
- alert tier is still calculated only from the base donation amount.

### TTS pricing and profiles

Current default profiles:

| ID | Label | Default fee | Default state | Language |
|---|---|---:|---|---|
| `standard` | Стандартная | +10 ⭐ | enabled | `ru-RU` |
| `premium` | Премиум | +25 ⭐ | disabled | `ru-RU` |
| `premium_plus` | Премиум+ | +40 ⭐ | disabled | `ru-RU` |
| `ultra` | Ультра | +75 ⭐ | disabled | `ru-RU` |
| `ultra_plus` | Ультра+ | +100 ⭐ | disabled | `ru-RU` |

The admin can currently:

- enable/disable a profile;
- change its fee;
- rename it;
- run a test.

Current profiles store `lang`, `rate`, `pitch`, and `voiceName`, but the Telegram admin UI currently exposes only enable/disable, name, price, and test. The premium slots are **future extension points**, not yet real external/custom celebrity voice engines.

### Adaptive alert visibility

The overlay no longer uses only a fixed timeout.

- short comments respect the tier minimum;
- long comments remain visible longer based on word/character count;
- when TTS is selected, the alert waits for both:
  - reading/display time;
  - TTS completion;
- TTS has a safe timeout so a broken browser voice cannot block the queue forever.

### Donation goal

One current active goal model:

- enable/hide widget;
- set goal title;
- set Stars target;
- use real current bot Stars balance;
- dedicated horizontal/vertical OBS Browser Source;
- realtime updates after payment/refund;
- periodic fallback balance sync.

The visual percentage is clamped to 100%, but the actual current Stars number may exceed the target.

### Telegram Stars balance

Uses official Bot API method:

```text
getMyStarBalance
```

Balance is cached in Durable Object storage for ~30 seconds. Goal widget normally updates in realtime and uses a slow fallback refresh every ~120 seconds. Manual admin refresh and payment/refund paths may force a balance refresh.

### Horizontal / vertical overlays

- normal OBS: intended for `1920×1080`;
- TikTok/vertical: intended for `1080×1920`.

Both alert and goal widget have landscape and vertical routes.

### WebSocket reconnect

Alert overlay:

- reconnects with exponential backoff from ~800 ms up to 10 s;
- server sends up to the latest 100 persisted real alerts on `hello`;
- each real alert has a monotonic `seq`;
- browser stores `lastSeenSeq` in `localStorage` per layout;
- client has an additional in-memory `known` set for alert IDs;
- legacy timestamp reconnect state is migrated if present.

### Payment history

- persisted in DO storage;
- current history list is bounded to latest 100 persisted real alerts;
- `/admin` displays latest 10 real payments;
- refund buttons are offered for eligible recent payments (currently first 5 shown as refund buttons).

### Test alerts

Admin can:

- choose a tier and send a test alert without Stars;
- test each TTS profile without Stars.

Test alerts are not stored as real payment history.

---

## 6. Full Telegram Stars payment flow

### Step 1 — viewer starts bot

Viewer sends:

```text
/start
```

Bot displays preset Stars buttons plus:

- custom amount;
- terms;
- payment support.

### Step 2 — terms acceptance

Before first donation, the bot requires the viewer to accept the project payment/support terms.

State:

```text
terms:<telegram_user_id>
```

If not accepted, intended donation selection is temporarily stored in:

```text
pending:<telegram_user_id> = { stage: "terms", intended: ... }
```

### Step 3 — amount selection

Viewer chooses a preset or custom amount.

For custom amount:

```text
pending:<user_id> = { stage: "custom" }
```

After a valid amount:

```text
pending:<user_id> = { stage: "comment", amount }
```

### Step 4 — comment

Bot asks for a comment up to 140 chars or allows “Без комментария”.

If there is no comment, invoice can be created directly without TTS.

If a comment exists and at least one TTS profile is enabled, flow becomes:

```text
pending:<user_id> = {
  stage: "tts",
  baseAmount,
  comment
}
```

### Step 5 — optional TTS selection

Viewer sees only enabled TTS profiles, e.g.:

```text
🔊 Стандартная +10 ⭐
Без озвучки
```

Pricing is calculated as:

```text
baseAmount = donation amount selected by viewer
ttsFee     = selected enabled profile fee, or 0
totalAmount = baseAmount + ttsFee
```

Important:

```text
animation tier = based on baseAmount only
Telegram invoice total = totalAmount
```

Example:

```text
100 ⭐ donation + 10 ⭐ standard TTS = 110 ⭐ charged
animation tier = 100–249 ⭐ tier
```

### Step 6 — order creation

`createInvoice()` creates a unique payload similar to:

```text
st_<time>_<random>
```

Stored as:

```text
order:<payload>
```

Important order fields:

```text
payload
userId
user
amount
totalAmount
baseAmount
ttsFee
tts
comment
createdAt
status = "invoice_sent"
```

### Step 7 — Telegram `sendInvoice`

The bot calls `sendInvoice` with:

```text
currency = "XTR"
```

Current code intentionally sends exactly **one** `LabeledPrice`, whose amount equals the full `totalAmount`.

No normal card-payment provider token is used for Stars.

### Step 8 — `pre_checkout_query`

Telegram posts the pre-checkout Update to `/telegram`.

The Durable Object loads `order:<invoice_payload>` and validates:

- order exists;
- order status is `invoice_sent`;
- payload matches;
- currency is `XTR`;
- amount matches expected `totalAmount`;
- Telegram user ID matches the order owner.

The Worker returns a direct webhook response in the Bot API format:

```json
{
  "method": "answerPreCheckoutQuery",
  "pre_checkout_query_id": "...",
  "ok": true
}
```

This avoids an additional Worker → Telegram API HTTP round trip during the pre-checkout 10-second window.

### Step 9 — `successful_payment`

After Telegram actually charges Stars, the bot receives a message containing `successful_payment`.

The code validates again:

- order exists;
- payload matches;
- currency is `XTR`;
- `total_amount` matches order total;
- Telegram user ID matches;
- `telegram_payment_charge_id` exists.

No real OBS donation alert is created before this stage.

### Step 10 — permanent payment idempotency

Payment key:

```text
payment:<telegram_payment_charge_id>
```

On first processing, a Durable Object storage transaction atomically commits:

- permanent payment record;
- paid order state;
- bounded payment alert history;
- next monotonic `alertSeq`.

The payment record includes fields such as:

```text
chargeId
payload
userId
totalAmount
baseAmount
status = "committed"
delivery = "pending"
receiptSent = false
createdAt
order
alert
```

### Step 11 — OBS event

If payment record `delivery !== "sent"`:

- event is broadcast to connected `mode=alerts` WebSockets;
- payment record becomes `delivery = "sent"`;
- goal balance is force-refreshed/broadcast.

Alert ID is the Telegram payment charge ID for real payments.

### Step 12 — viewer receipt

Bot sends a “Stars received / alert sent” confirmation message.

v5.1 uses `payment-receipt.js` so concurrent successful-payment retries cannot send four identical receipts at the same time.

### Step 13 — retry behavior

Telegram webhook exceptions return `503`, allowing Telegram to retry.

Two different dedupe strategies are intentionally used:

#### Ordinary commands/callbacks

Reserved atomically **before** side effects by `update-dedupe.js`, so simultaneous Telegram retries do not produce duplicate `/admin` responses, etc.

#### Payment-critical updates

Not early-reserved, because payment processing must remain retryable. Safety comes from payment identity/state, especially `telegram_payment_charge_id`.

### Step 14 — refunds

Admin may select an eligible payment from history and confirm a full refund.

Code calls:

```text
refundStarPayment(user_id, telegram_payment_charge_id)
```

Both manual refund completion and Telegram `refunded_payment` service messages update order/payment state to `refunded` and refresh the goal balance.

---

## 7. How state is stored

All persistent application state currently lives inside the single SQLite-backed Durable Object instance.

Key/value storage is used through the Durable Object Storage API. With SQLite-backed DOs, Cloudflare persists these entries within the SQLite-backed storage model; there is no separate Workers KV dependency.

Important keys/prefixes:

| Key / prefix | Purpose |
|---|---|
| `config` | overlay key, amounts, tiers, media metadata, TTS profiles, goal config, origin |
| `adminUserId` | Telegram user ID of claimed owner |
| `starBalance` | cached `getMyStarBalance` result |
| `history` | latest persisted real alert/payment events, max ~100 |
| `alertSeq` | monotonic alert sequence counter |
| `order:<payload>` | invoice/order state |
| `payment:<chargeId>` | permanent payment/idempotency/refund/receipt state |
| `pending:<userId>` | current viewer conversation state: terms/custom/comment/TTS/support |
| `terms:<userId>` | accepted terms timestamp |
| `adminAction:<userId>` | pending admin edit/upload action |
| `invoiceRate:<userId>` | last successful invoice creation timestamp for spam cooldown |
| `lastOrderCleanup` | throttle for lazy stale-order cleanup |
| `processedUpdatesV2` | recent ordinary Telegram update fingerprints/update IDs |
| `processedUpdates` | legacy dedupe list read during migration compatibility |

Media binaries are **not** stored in Durable Object storage. Only Telegram `file_id`, MIME, and metadata are stored in `config`.

---

## 8. Durable Objects used

There is one binding:

```text
Binding name: HUB
Class: StreamHub
Storage: sqlite
```

The Worker always resolves one named instance:

```js
const id = env.HUB.idFromName("starchik-main");
```

Therefore the entire current bot/stream is serialized through a single logical Durable Object instance named:

```text
starchik-main
```

This is intentional for a single-streamer deployment because it provides:

- strongly coordinated state;
- payment transactions;
- one WebSocket hub;
- simple configuration;
- no distributed-locking problem.

No Durable Object Alarm is currently used.

---

## 9. Security model

### Telegram webhook

`/telegram` accepts POST only.

Telegram webhook requests must include:

```text
X-Telegram-Bot-Api-Secret-Token
```

Primary secret:

```text
TELEGRAM_WEBHOOK_SECRET
```

During the v4 → v5 migration, current code also supports legacy `APP_SECRET` as fallback/accepted secret. **Once the dedicated webhook secret has been bootstrapped and verified, remove `APP_SECRET` from Cloudflare to eliminate the legacy path.**

### Setup/bootstrap

Protected by:

```text
SETUP_SECRET
```

Endpoint uses:

```text
/bootstrap?code=<SETUP_SECRET>
```

It configures:

- Telegram webhook URL;
- Telegram webhook secret token;
- allowed update types;
- bot command menu.

### Admin owner claim

Protected by:

```text
CLAIM_SECRET
```

Initial owner uses:

```text
/claim <CLAIM_SECRET>
```

After `adminUserId` exists, another Telegram account cannot claim ownership through the normal bot flow.

Every `adm:*` callback verifies `isAdmin(userId)`.

### OBS overlay URL

Protected by a generated random `overlayKey` stored in `config`.

It is checked on:

- `/ws`;
- `/media/*`;
- `/status`;
- `/goal-state`.

The same OBS key is used for alert overlay and goal widget URLs.

Admin can rotate it through:

```text
/admin → 🔐 Новый OBS-ключ
```

Rotation:

- generates a new random key;
- closes currently open WebSockets;
- invalidates all old OBS links;
- sends fresh alert and goal URLs to the admin.

### WebSocket fake-donation protection

A public WebSocket client cannot submit a donation event.

Current server behavior:

- `ping`/`pong` is handled through Hibernation auto-response;
- any other incoming WebSocket client message reaches `webSocketMessage()` and is rejected/connection closed;
- only the server-side payment/admin test paths call `emitAlert()`.

Therefore a viewer who merely knows the public Worker URL cannot send a JSON fake donation through the WebSocket API.

### Payment protection

A real alert depends on a Telegram `successful_payment` that passes:

- payload validation;
- `XTR` validation;
- amount validation;
- Telegram user validation;
- non-empty `telegram_payment_charge_id`;
- permanent charge-ID idempotency.

Test alerts exist only behind Telegram admin authorization and are marked `test: true`.

### Secret handling

Do not commit any secret values.

Current `.gitignore` excludes:

```text
node_modules/
.wrangler/
.dev.vars
.env
*.log
```

---

## 10. Cloudflare bindings and environment variables

### Bindings declared in `wrangler.jsonc`

#### `ASSETS`

Type: Static Assets binding  
Source directory: `./public`

Used for HTML/JS/CSS static assets.

#### `HUB`

Type: Durable Object binding  
Class: `StreamHub`  
Storage: SQLite-backed

### Non-secret text variables declared in GitHub / `wrangler.jsonc`

```text
BOT_USERNAME=ttt_stars_bot
BRAND_NAME=starchik
```

These are not credentials.

### Runtime secrets in Cloudflare

Expected dedicated production secrets:

```text
BOT_TOKEN
TELEGRAM_WEBHOOK_SECRET
CLAIM_SECRET
SETUP_SECRET
```

### Legacy migration secret

```text
APP_SECRET
```

`APP_SECRET` is **not part of the desired long-term secret model**. v5 supports it only as a migration fallback for setup/claim/webhook compatibility.

At this snapshot, the Cloudflare dashboard still showed `APP_SECRET` together with the dedicated v5 secrets. After confirming dedicated-secret bootstrap + normal webhook operation, remove `APP_SECRET`.

### Secret backend compatibility

`resolveSecret()` supports both:

- normal Worker runtime Secret values (string);
- a Cloudflare Secrets Store binding exposing `.get()`.

The currently recommended configuration for this project is **Worker → Settings → Runtime variables and secrets**, not Build variables.

---

## 11. What belongs in Cloudflare vs GitHub

### GitHub

Safe to store:

```text
source code
public overlay code
tests
README
package.json
wrangler.jsonc
BOT_USERNAME
BRAND_NAME
binding names / class names
route definitions
```

Do **not** store:

```text
BOT_TOKEN
TELEGRAM_WEBHOOK_SECRET
CLAIM_SECRET
SETUP_SECRET
APP_SECRET
real OBS overlayKey
```

### Cloudflare dashboard/runtime

Contains:

- runtime secrets;
- connected GitHub repository;
- build/deploy configuration;
- Worker URL/domain;
- Durable Object instance/storage;
- Worker logs/observability;
- deployment history.

### Durable Object storage

Contains application runtime data/config, including the private OBS overlay key and admin Telegram ID.

---

## 12. Deployment: GitHub → Cloudflare

Intended workflow:

```text
local/project ZIP
  → update GitHub main
  → Cloudflare detects commit
  → Cloudflare build
  → tests/syntax verification
  → wrangler deploy
  → Worker production deployment
```

Recommended Cloudflare Build command:

```bash
npm install && npm run verify
```

Recommended Deploy command:

```bash
npx wrangler deploy
```

Project scripts:

```json
{
  "dev": "wrangler dev",
  "deploy": "wrangler deploy",
  "test": "node --test tests/*.test.mjs",
  "check": "node --check src/index.js && node --check src/v4-logic.js && node --check src/overlay-route.js && node --check src/update-dedupe.js && node --check src/payment-receipt.js",
  "verify": "npm test && npm run check"
}
```

Wrangler is pinned:

```text
4.127.1
```

**Important:** no `package-lock.json` is present in the v5.1 snapshot. `wrangler` itself is exact-pinned, but reproducibility would improve if a future update intentionally adds and commits a lockfile and switches the build to `npm ci`.

---

## 13. Public routes / OBS URLs / endpoints

Use `<ORIGIN>` as the Worker origin and `<OBS_KEY>` as the secret overlay key.

Current production origin is normally:

```text
https://telegram-stars-obs.sultanov-tab.workers.dev
```

### General endpoints

```text
GET  <ORIGIN>/health
GET  <ORIGIN>/bootstrap?code=<SETUP_SECRET>
POST <ORIGIN>/telegram
```

### Alert OBS Browser Source

Landscape:

```text
<ORIGIN>/overlay/landscape?key=<OBS_KEY>
```

Vertical:

```text
<ORIGIN>/overlay/vertical?key=<OBS_KEY>
```

Recommended OBS canvas/source dimensions:

```text
landscape: 1920×1080
vertical:  1080×1920
```

Debug:

```text
<ORIGIN>/overlay/landscape?key=<OBS_KEY>&debug=1
```

Preview without real payment:

```text
<ORIGIN>/overlay/landscape?key=<OBS_KEY>&preview=1
```

Preview with TTS:

```text
<ORIGIN>/overlay/landscape?key=<OBS_KEY>&preview=1&tts=1&debug=1
```

### Goal OBS Browser Source

Landscape:

```text
<ORIGIN>/goal/landscape?key=<OBS_KEY>
```

Vertical:

```text
<ORIGIN>/goal/vertical?key=<OBS_KEY>
```

Goal preview:

```text
<ORIGIN>/goal/landscape?key=<OBS_KEY>&preview=1
```

Goal debug:

```text
<ORIGIN>/goal/landscape?key=<OBS_KEY>&debug=1
```

### Internal/dynamic endpoints

WebSocket:

```text
<ORIGIN>/ws?key=<OBS_KEY>&layout=landscape&mode=alerts
<ORIGIN>/ws?key=<OBS_KEY>&layout=vertical&mode=alerts
<ORIGIN>/ws?key=<OBS_KEY>&layout=landscape&mode=goal
<ORIGIN>/ws?key=<OBS_KEY>&layout=vertical&mode=goal
```

Alert status/config:

```text
GET <ORIGIN>/status?key=<OBS_KEY>
```

Goal state:

```text
GET <ORIGIN>/goal-state?key=<OBS_KEY>
```

Media proxy:

```text
GET <ORIGIN>/media/animation/<tier>?key=<OBS_KEY>
GET <ORIGIN>/media/sound/<tier>?key=<OBS_KEY>
```

Tier indexes are `0..5`.

---

## 14. Telegram bot commands

Registered through `setMyCommands` during `/bootstrap`:

```text
/start
/admin
/terms
/paysupport
```

### `/start`

Shows donation amount menu.

### `/admin`

Owner-only admin panel.

### `/terms`

Shows payment/support terms and acceptance button.

### `/paysupport`

Starts one-message payment support flow. The viewer's message is forwarded to the stored admin Telegram ID.

Alias accepted by code:

```text
/support
```

### `/claim <CLAIM_SECRET>`

Initial installation/owner claim command. Not registered in the public bot command menu.

Only works when `adminUserId` has not yet been set.

---

## 15. Telegram admin panel

Top-level `/admin` buttons:

```text
🎬 Анимации
🔊 Звуки
🗣 Озвучка
⭐ Суммы
🎯 Цель сбора
💰 Баланс
🧪 Тест алерта
🔗 OBS-ссылки
📋 Последние платежи
🔐 Новый OBS-ключ
```

### 🎬 Анимации

- choose Stars tier;
- bot stores an `adminAction` waiting for media upload;
- send GIF/WebM/MP4/image/static or video sticker;
- assign Telegram `file_id` to the selected tier;
- delete assigned tier animation.

### 🔊 Звуки

- choose Stars tier;
- send audio / voice / audio document;
- assign sound to tier;
- delete assigned sound.

### 🗣 Озвучка

Shows 5 TTS profiles.

Per profile:

```text
enable / disable
change Stars surcharge
rename
send TTS test alert
```

Only enabled profiles are offered to viewers.

### ⭐ Суммы

Admin sends a new comma/space-separated list.

Validation:

- 2–12 amounts;
- each 1–10000 Stars;
- deduplicated and sorted.

### 🎯 Цель сбора

Controls:

```text
show/hide widget
change title
change target amount
force-refresh Telegram Stars balance
get goal OBS URLs
```

### 💰 Баланс

Force-fetches current Telegram bot Stars balance and shows progress against current goal.

### 🧪 Тест алерта

Choose tier and emit test event to alert WebSocket without Stars/payment.

### 🔗 OBS-ссылки

Sends protected alert Browser Source URLs for landscape and vertical layouts.

### 📋 Последние платежи

Displays latest 10 real payment alerts.

For eligible recent paid orders:

- offers refund button;
- requires a second confirmation;
- then calls `refundStarPayment`.

### 🔐 Новый OBS-ключ

- rotates `overlayKey`;
- closes open sockets;
- invalidates all old OBS URLs;
- sends new alert + goal links.

---

## 16. Known limitations and technical debt

These are not necessarily blockers for a small streamer, but a new developer should know them before making assumptions.

### 16.1 GitHub/source version mismatch at snapshot

Public GitHub `main` was still showing v4 while the latest prepared code package is v5.1. Reconcile before development.

### 16.2 Legacy `APP_SECRET` migration path still exists

Current code accepts `APP_SECRET` as fallback and may accept it as a legacy webhook secret while present in Cloudflare. Remove it after dedicated v5 secrets have been verified.

### 16.3 TTS is browser Speech Synthesis, not generated audio

Current `standard/premium/...` profiles are configuration slots over Web Speech API parameters. They are not yet server-generated MP3 files and not yet integrations with third-party/custom voice services.

Implications:

- available voices depend on Windows/OBS/CEF;
- browser autoplay/voice-loading behavior may vary;
- OBS/CEF updates can affect SpeechSynthesis;
- errors are visible in debug/console, but there is no server-side TTS delivery guarantee.

Possible future direction: generate actual audio files from a dedicated TTS provider and play them as ordinary audio in the overlay.

### 16.4 Premium voice slots are placeholders

Admin can enable/price/name them, but there is currently no per-profile provider API, model ID, voice upload, or secure server-generated voice pipeline.

### 16.5 Payment receipt retry lease can be improved

`claimPaymentReceipt()` atomically prevents concurrent duplicate “thank you” messages. However, if sending the receipt fails after a claim, `failPaymentReceipt()` records failure but does not currently clear/expire `receiptClaimed`. A future hardening pass should add a retryable lease/timeout or clear the claim on failure, otherwise the receipt may remain unsent even though the payment itself is safely recorded and the OBS alert/history are unaffected.

### 16.6 Ordinary Telegram update dedupe is intentionally at-most-once

v5.1 reserves ordinary messages/callbacks before side effects to suppress duplicate webhook retries. If an external Telegram API call then fails, a Telegram retry of that exact ordinary update will be suppressed.

This is an intentional trade-off to stop 4× duplicate bot replies. Payment-critical updates use different retry-safe idempotency.

Future enhancement: explicit update processing states/leases (`reserved → done/failed`) if ordinary command reliability becomes important.

### 16.7 Alert reconnect cursor is marked when enqueued, not after fully displayed

`lastSeenSeq` is advanced when an alert is queued. If the OBS Browser Source crashes after receiving/enqueueing an alert but before rendering it, reconnect may treat it as seen.

For current small-stream use this edge case is acceptable. A stricter design would persist `lastPlayedSeq` after completed display.

### 16.8 First-ever overlay connection intentionally does not replay old history

A brand-new Browser Source with no saved cursor marks existing recent history as known instead of replaying all previous donations. This avoids a flood of historical alerts when OBS is first added.

### 16.9 One Durable Object / one streamer

The architecture is intentionally single-tenant around `starchik-main`. It is not yet a multi-streamer SaaS design.

If the project becomes multi-tenant, use separate DO names per streamer/bot/channel and revisit auth/config boundaries.

### 16.10 No `package-lock.json`

Wrangler is exact-pinned, but the dependency tree is not lockfile-pinned. Add `package-lock.json` + `npm ci` later if reproducible builds become a priority.

### 16.11 Terms are not versioned

`terms:<userId>` stores only acceptance timestamp. If legal/payment terms materially change, existing users are not automatically required to re-accept a new terms version.

### 16.12 Support flow is minimal

`/paysupport` forwards a user message to the admin, but there is no structured ticket state or admin “reply through bot” UI.

### 16.13 Media is fetched from Telegram on demand

Media is stored by `file_id`, not copied to R2. This is simple and currently appropriate, but every uncached media request depends on Telegram file availability.

The overlay currently appends a timestamp query parameter to animation/sound URLs, which reduces effective browser caching. If media traffic grows, revisit caching or R2—not needed now.

### 16.14 Goal semantics = current available bot balance

Goal progress is based on `getMyStarBalance`, not “all Stars ever donated to this specific goal”. Therefore withdrawals/refunds reduce the displayed progress. This is intentional in current design.

If future goal semantics should be “gross contributions since goal start”, create a separate goal ledger rather than using current balance.

### 16.15 One active goal model

Current config holds one goal `{enabled,title,target}`. Multiple simultaneous independent goals are not implemented.

### 16.16 No automatic moderation

Comments are length-limited and safely rendered as text, but there is no profanity/spam/moderation filter. Add only if needed.

---

## 17. Hardening already implemented after security/performance audit

The current intended v5.1 code includes these changes and they should **not be accidentally reverted**.

### Payment hardening

- direct webhook response for `pre_checkout_query` to reduce 10-second timeout risk;
- validates payload, `XTR`, amount, user, order state;
- successful payment re-validates payload/currency/amount/user;
- requires `telegram_payment_charge_id`;
- permanent `payment:<chargeId>` idempotency record;
- transaction commits payment + paid order + history + `alertSeq` atomically;
- payment alert delivery state `pending/sent`;
- webhook exceptions return `503` so Telegram may retry;
- `refundStarPayment` support;
- `refunded_payment` handling;
- invoice rate limit (~1.5 seconds/user);
- stale unpaid invoice cleanup after ~7 days, lazily and no more often than ~6 hours.

### Duplicate webhook hotfix v5.1

- ordinary message/callback fingerprinting;
- transactionally reserve update before bot side effects;
- concurrent duplicate Updates return `200 { duplicate: true }`;
- payment-critical updates are excluded from early reservation;
- legacy `processedUpdates` recognized during migration;
- payment thank-you receipt gets an atomic concurrent-claim guard.

### Security hardening

Separated long-term secrets:

```text
BOT_TOKEN
TELEGRAM_WEBHOOK_SECRET
CLAIM_SECRET
SETUP_SECRET
```

OBS key remains separate from all of them.

### WebSocket / OBS hardening

- Hibernation API through `ctx.acceptWebSocket()`;
- automatic `ping`/`pong` response without waking DO;
- incoming arbitrary WebSocket client messages rejected;
- alert and goal sockets separated by mode;
- monotonic alert `seq`;
- reconnect uses sequence instead of timestamp;
- server exposes up to 100 recent persisted alerts for reconnect recovery;
- route rewrite preserves OBS query parameters.

### Goal efficiency

- realtime WebSocket is primary;
- goal fallback polling reduced to ~120 seconds;
- public goal endpoint cannot request forced Telegram balance refresh;
- payment/refund/admin refresh paths can update balance immediately;
- no Alarm API polling while OBS is offline.

### Static asset / Cloudflare efficiency

`run_worker_first` is restricted to dynamic routes instead of routing every static asset through Worker logic.

Current patterns:

```text
/health
/bootstrap
/telegram
/ws
/media/*
/status
/goal-state
/overlay/*
/goal/*
```

### TTS hardening

- animation tier uses base donation, not TTS surcharge;
- long text remains visible longer;
- TTS completion is awaited;
- TTS timeout fallback;
- errors logged and exposed in `debug=1` instead of silently disappearing.

---

## 18. Deliberately NOT used

Do not add these merely because they are familiar tools. Current architecture does not need them for the present single-streamer scale.

### Workers KV — not used

Reason:

- state already lives in a strongly coordinated Durable Object;
- payment/idempotency flows benefit from transactional/serialized state;
- a separate eventually-consistent KV layer adds complexity without benefit.

### Cloudflare D1 — not used

Reason:

- SQLite-backed Durable Object storage already covers current persistent state;
- one streamer / one DO does not need a separate relational database service.

### Supabase — not used

Reason:

- unnecessary external database/auth/network dependency;
- current DO already gives storage + coordination + realtime hub.

### Pusher / Ably / separate realtime provider — not used

Reason:

- Durable Object Hibernating WebSockets already provide realtime delivery.

### VPS — not used

Reason:

- no always-on Node/Python process is required;
- Cloudflare Worker/DO handles webhook + storage + realtime.

### Cloudflare Queues — not used

Reason:

- current payment/event volume is small;
- DO coordination is enough.

Potential future use only if external TTS/media processing or very high event volume creates background-work requirements.

### Durable Object Alarm API — not used

Reason:

- goal should not poll Telegram while OBS is offline;
- realtime + slow browser fallback is cheaper/simpler.

### R2 — not used

Media currently stays in Telegram and is referenced by `file_id`.

Consider R2 only if independent media hosting/caching becomes necessary.

---

## 19. How a new ChatGPT/developer should start work

Use this procedure every time a new development conversation begins.

### Step A — establish the real source of truth

1. Ask for or inspect the current GitHub repository.
2. Check `package.json` version.
3. Check latest commit / README.
4. If GitHub is not v5.1 or newer, ask the user for the latest saved project ZIP/repository export.
5. Never reconstruct missing code from this handoff alone.

Expected current baseline:

```text
package.json version = 5.1.0
src/update-dedupe.js exists
src/payment-receipt.js exists
```

### Step B — read the code before proposing changes

At minimum inspect fully:

```text
src/index.js
src/v4-logic.js
src/update-dedupe.js
src/payment-receipt.js
public/overlay.html
public/overlay-logic.js
public/goal.html
wrangler.jsonc
package.json
all relevant tests
```

Do not rely on the filename `v4-logic.js` to infer project version; v5.1 still uses that module name.

### Step C — establish deployment/config state

Ask for screenshots only if required. Verify:

```text
Cloudflare runtime secrets exist
HUB binding exists
ASSETS binding exists
workers.dev URL enabled
GitHub auto deployment enabled
Cloudflare latest deployment is healthy
```

Never ask the user to expose secret values. Names/status are normally sufficient.

### Step D — reproduce before changing

For bugs:

- use Cloudflare Observability / Live Logs;
- identify exact `/telegram`, Durable Object, `/ws`, `/media`, or `/goal-state` behavior;
- reproduce with one action;
- inspect current code path;
- add a failing regression test before fixing production code when practical.

### Step E — preserve invariants

Do not accidentally break these important design rules:

1. Real alert only after verified `successful_payment`.
2. TTS surcharge changes invoice total, not animation tier.
3. Payment-critical webhook retries remain retry-safe.
4. Ordinary Telegram duplicate retries do not create duplicate bot replies.
5. OBS WebSocket client cannot emit fake donations.
6. Real secret values never go into GitHub.
7. Existing Durable Object state must survive code deployment.
8. Existing OBS URLs should remain stable unless admin intentionally rotates the overlay key.

### Step F — verify official docs for API-sensitive changes

Before changing Telegram Stars payments or Cloudflare platform behavior, re-check current official documentation because these APIs and limits can evolve.

Useful references:

```text
Telegram Bot API:
https://core.telegram.org/bots/api

Telegram Stars payments:
https://core.telegram.org/bots/payments-stars

Cloudflare Workers limits:
https://developers.cloudflare.com/workers/platform/limits/

Durable Objects:
https://developers.cloudflare.com/durable-objects/

Durable Object SQLite storage:
https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/

Durable Object WebSocket Hibernation:
https://developers.cloudflare.com/durable-objects/best-practices/websockets/

Workers secrets:
https://developers.cloudflare.com/workers/configuration/secrets/

Workers Static Assets:
https://developers.cloudflare.com/workers/static-assets/
```

### Step G — run verification before handing a build back

At minimum:

```bash
npm test
npm run check
```

Preferred:

```bash
npm run verify
```

If a UI/OBS overlay was changed, also validate the rendered overlay in a real browser/OBS-compatible environment, not only source tests.

---

## 20. Files the user should provide to a new ChatGPT

Best option: provide the **entire current repository as a ZIP**.

If that is not possible, provide at least:

```text
package.json
wrangler.jsonc
README.md

src/index.js
src/v4-logic.js
src/update-dedupe.js
src/payment-receipt.js
src/overlay-route.js

public/overlay.html
public/overlay-logic.js
public/goal.html
public/index.html

tests/  (entire folder)
```

Also provide this file:

```text
PROJECT_CONTEXT.md
```

For deployment-specific debugging, also useful:

- screenshot of Cloudflare Worker `Settings → Runtime variables and secrets` showing **names only**, not values;
- screenshot of `Bindings`;
- latest Cloudflare Deployment status;
- relevant Cloudflare Live Logs after one reproducible action;
- OBS Browser Source properties if the problem is overlay/audio related.

Do **not** provide secret values unless a specific trusted workflow genuinely requires them.

---

## 21. Checklist before every new deployment

### Source/version

- [ ] Confirm editing the latest source, not an old ZIP/chat copy.
- [ ] `package.json` version intentionally updated if this is a release.
- [ ] Review `git diff` / changed files.

### Secrets/security

- [ ] No real Bot Token in source.
- [ ] No webhook/setup/claim secret in source.
- [ ] No OBS key hardcoded in source/tests/screenshots.
- [ ] No `.env`, `.dev.vars`, logs, or secrets accidentally staged.
- [ ] If changing `/telegram`, preserve secret-header validation.
- [ ] If changing admin callbacks, preserve `isAdmin()` checks.
- [ ] If changing WebSocket behavior, do not allow clients to submit alert events.

### Telegram payment correctness

- [ ] `sendInvoice` uses `currency: "XTR"`.
- [ ] Stars invoice still uses the expected single total `LabeledPrice`.
- [ ] Pre-checkout validates order/payload/currency/amount/user.
- [ ] Pre-checkout response remains fast/direct.
- [ ] `successful_payment` validates payload/currency/amount/user/charge ID.
- [ ] No real alert path bypasses `successful_payment`.
- [ ] Payment idempotency still keyed by `telegram_payment_charge_id`.
- [ ] Refund code, if touched, preserves charge ID + user mapping.

### OBS/realtime

- [ ] Alert WebSocket and goal WebSocket modes remain separated.
- [ ] Overlay key required on protected OBS endpoints.
- [ ] Reconnect sequence logic preserved.
- [ ] Client alert queue still serializes alerts.
- [ ] Test events are visibly marked test/non-payment.

### TTS

- [ ] TTS surcharge calculated separately from base amount.
- [ ] Animation tier still uses `baseAmount` only.
- [ ] Long-comment visibility still adaptive.
- [ ] TTS errors cannot permanently freeze queue.

### Goal

- [ ] `getMyStarBalance` remains source of current-balance goal.
- [ ] No aggressive polling added.
- [ ] payment/refund still broadcasts goal update.

### Cloudflare/resources

- [ ] No unnecessary KV/D1/external service added.
- [ ] `run_worker_first` still selective.
- [ ] DO binding/class/storage config unchanged unless migration is intentional.
- [ ] Any storage schema/state change is backwards compatible with existing `starchik-main` data.

### Verification

- [ ] `npm run verify` passes.
- [ ] New bug/feature has regression tests where practical.
- [ ] ZIP/archive contains expected files and no secrets.

---

## 22. Checklist after deployment

Run this in order.

### 1. Health

Open:

```text
<ORIGIN>/health
```

Expected: JSON with `ok: true`, service `starchik`, and bot username.

### 2. Telegram webhook

- [ ] Send one `/start`.
- [ ] Bot replies once, not 4 times.
- [ ] Send one `/admin` from owner account.
- [ ] Admin panel replies once.
- [ ] If debugging, inspect Cloudflare Observability events for `/telegram` and DO requests.

If dedicated security secrets were changed, run `/bootstrap?code=<SETUP_SECRET>` once and confirm webhook is connected.

### 3. Test alert

From:

```text
/admin → 🧪 Тест алерта
```

Choose a tier.

Expected:

- exactly one alert reaches OBS;
- correct tier media/sound;
- alert enters/leaves screen cleanly;
- no fake payment history entry.

### 4. Payment test

Use the smallest practical real Stars payment.

Verify:

- terms flow;
- amount/comment/TTS selection;
- Telegram invoice total;
- successful payment confirmation;
- exactly one OBS alert;
- exactly one thank-you receipt;
- payment appears once in history;
- animation tier uses base amount, not total with TTS fee.

### 5. OBS alert Browser Source

Verify both if used:

```text
landscape
vertical
```

Check:

- transparent background;
- animation;
- comment wrapping;
- sound;
- reconnect after Browser Source refresh;
- no replay storm after reconnect.

### 6. TTS

Run:

```text
/admin → 🗣 Озвучка → profile → 🧪 Тест озвучки
```

Verify:

- text appears;
- speech is audible in the intended stream audio path;
- alert remains until speech/reading duration ends;
- `&debug=1` shows meaningful status if TTS fails.

If browser SpeechSynthesis behaves differently after OBS/Windows updates, test the same overlay URL in Chrome and inspect console errors before changing backend code.

### 7. Goal widget

Verify:

- goal Browser Source loads;
- correct title/target;
- current real balance;
- realtime update after payment/refund;
- fallback refresh eventually reflects withdrawal/refund balance changes.

### 8. Balance

Use:

```text
/admin → 💰 Баланс
```

Confirm it matches Telegram's current bot Stars balance expectations.

### 9. Refund test when refund logic changes

Only when intentionally testing refund behavior:

- use an eligible known test payment;
- admin history → refund → confirm;
- verify Telegram refund response;
- order/payment state becomes refunded;
- goal balance refreshes.

---

## 23. Version / snapshot status

```text
Project: starchik / telegram-stars-obs
Intended current version: 5.1.0
Snapshot date: 2026-09-02
Architecture: Telegram Bot API + Cloudflare Worker + one SQLite-backed Durable Object + Hibernating WebSockets + OBS Browser Source
Bot: @ttt_stars_bot
Brand: starchik
```

v5.1 is the duplicate-webhook hotfix on top of v5 payment/security/performance hardening.

Snapshot verification performed against the v5.1 source archive:

```text
48 tests passed
syntax check passed
```

### Critical handoff reminder

Before any future developer/ChatGPT edits the project:

1. inspect actual current repository/source files;
2. confirm whether GitHub has v5.1 or newer;
3. never infer current behavior from this document when source disagrees;
4. treat code as source of truth and this file as architectural/context guidance;
5. re-check current Telegram and Cloudflare official documentation for payment/platform-sensitive changes.

