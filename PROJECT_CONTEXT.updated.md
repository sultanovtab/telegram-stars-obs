# PROJECT_CONTEXT.md — starchik / Telegram Stars → OBS

**Snapshot date:** `2026-09-09`  
**Repository:** `https://github.com/sultanovtab/telegram-stars-obs`  
**Current main merge:** `a673277` (PR #2)  
**Feature implementation commit:** `94c4e77`  
**package.json version:** `5.1.0`  
**Bot:** `@ttt_stars_bot`  
**Brand:** `starchik`  
**Cloudflare Worker:** `telegram-stars-obs`

> SOURCE OF TRUTH: always inspect the CURRENT CODE first.  
> If this file, README, comments, or old ZIPs disagree with the current repository, CURRENT CODE wins.

> PRODUCTION SAFETY: this project already contains real Telegram Stars payments and persistent Durable Object data. Never delete, bulk-migrate, rewrite, normalize, or replay historical orders/payments/history unless a migration is proven necessary and explicitly approved.

> SECURITY: this document intentionally contains no real secret values and no real overlay key. Never ask the user to paste `BOT_TOKEN`, Cloudflare passwords, GitHub passwords, `TELEGRAM_WEBHOOK_SECRET`, `CLAIM_SECRET`, `SETUP_SECRET`, `APP_SECRET`, or `overlayKey` into ordinary chat.

---

# 1. Purpose

`starchik` is a Telegram Stars donation/alert system for OBS.

Viewers pay in Telegram Stars. A real alert is emitted to OBS only after Telegram sends a valid `successful_payment`.

The project intentionally avoids a larger third-party donation platform and uses:

```text
Telegram Bot API
        ↓
Cloudflare Worker
        ↓
one SQLite-backed Durable Object: StreamHub
        ↓
hibernating WebSockets
        ↓
OBS Browser Source
```

Primary requirements:

- safe Telegram Stars payment validation;
- idempotent payment handling;
- persistent history/config/payment state;
- realtime OBS alerts;
- backward compatibility with existing production Durable Object data;
- admin configuration from Telegram;
- no unnecessary infrastructure rewrite.

---

# 2. Current architecture

## Worker entry

Main file:

```text
src/index.js
```

Worker routes requests to one Durable Object:

```text
env.HUB.idFromName("starchik-main")
```

Main public/internal routes include:

```text
/telegram
/ws
/media/*
/status
/goal-state
/overlay/landscape
/overlay/vertical
/goal/landscape
/goal/vertical
/bootstrap
/health
```

## Durable Object

Class:

```text
StreamHub
```

Responsibilities:

- config;
- Telegram state machine;
- admin state/actions;
- pending viewer donation flow;
- invoice/order storage;
- payment records;
- history;
- alert sequence;
- refunds;
- goal state;
- WebSockets;
- OBS media proxying.

## Static assets

Important overlay files:

```text
public/overlay.html
public/overlay-logic.js
public/goal.html
```

---

# 3. Persistent storage keys

Important storage shapes/keys include:

```text
config
adminUserId
history
alertSeq

pending:<telegramUserId>
terms:<telegramUserId>

order:<invoicePayload>
payment:<telegramPaymentChargeId>

invoiceRate:<telegramUserId>

adminAction:<telegramUserId>
```

Other existing goal/dedupe/payment-receipt keys are also part of the production state.

DO NOT rename existing storage keys just for cleanliness.

DO NOT rewrite historical records merely to add new fields.

---

# 4. Existing production compatibility

Existing real payments may predate:

```text
displayName
media
mediaFee
ttsFee
baseAmount
playAt
```

New code must remain compatible.

Expected read-time/default behavior:

```text
old order missing displayName
→ historical fallback

old order missing media
→ no viewer media

old order missing mediaFee
→ 0

old order missing ttsFee
→ 0 / old pricing behavior

old order missing baseAmount
→ fallback to old amount

old alert/payment missing playAt
→ old timestamp/immediate compatibility behavior
```

No bulk historical migration is required by the 2026-09-09 feature update.

Config normalization may add defaults to the single `config` object when config is read/saved. This is separate from rewriting historical orders/payments/history.

---

# 5. Telegram donation viewer flow

Current intended flow:

```text
/start or donation menu
→ accept terms if necessary
→ choose preset amount OR custom amount
→ display_name stage
→ comment stage
→ optional TTS stage
→ optional viewer-media stage
→ createInvoice()
→ Telegram Stars invoice
→ pre_checkout_query
→ successful_payment
→ payment record + history alert
→ OBS
```

## Amount

Preset amounts are configured in `config.amounts`.

Custom amount:

```text
1 .. MAX_CUSTOM_STARS
```

Current code:

```text
MAX_CUSTOM_STARS = 10000
```

Invoice creation is rate-limited per viewer.

---

# 6. Display-name behavior

Helper:

```text
sanitizeDisplayName()
```

Rules:

- whitespace/control characters normalized;
- maximum 30 JS string characters;
- empty/anonymous values become:
  `Unknown`.

New order field:

```text
displayName
```

Viewer has:

- manual text entry;
- anonymous option → `Unknown`;
- "use default name" button.

## IMPORTANT CURRENT-CODE NOTE

Current `name:default` path calls:

```text
formatUser(user)
```

and `formatUser()` prefers Telegram `@username` when it exists.

Therefore the current code does NOT yet implement the strictest version of the product requirement "never show Telegram @username for new donations" if the viewer chooses that default-name button.

Future fix should change the default-name button to a non-username value (for example first_name/last_name) or remove that option entirely.

Historical records should still retain their legacy fallback behavior.

---

# 7. TTS pricing and snapshots

Default TTS profiles live in:

```text
src/v4-logic.js
DEFAULT_TTS_PROFILES
```

Pricing helper:

```text
buildOrderPricing(baseAmount, profile, mediaFee)
```

At invoice creation, order stores:

```text
baseAmount
ttsFee
mediaFee
totalAmount
tts
media
displayName
```

TTS object is a snapshot:

```text
id
label
price
lang
rate
pitch
voiceName
```

Admin changing a TTS profile later must not change an already-created order.

---

# 8. Tier calculation invariant

Animation/sound tier MUST be selected from:

```text
baseAmount
```

NOT:

```text
totalAmount
```

Example:

```text
baseAmount = 100
ttsFee     = 10
mediaFee   = 25
totalAmount= 135
```

Invoice total:

```text
135 ⭐
```

Tier:

```text
tier for 100 ⭐
```

Relevant helper:

```text
findTierIndex(baseAmount, cfg.tiers)
```

---

# 9. Viewer media addon

Config default:

```js
viewerMedia = {
  enabled: false,
  price: 25,
  allowPhoto: true,
  allowSticker: true,
  maxBytes: 10 * 1024 * 1024
}
```

Admin can currently:

- enable/disable viewer media;
- change media Stars price.

Current admin UI displays allowed photo/sticker flags.

## Supported media

Accepted:

```text
Telegram photo
static WEBP sticker
```

Rejected:

```text
TGS animated sticker
video sticker
unsupported documents/media types
file > viewerMedia.maxBytes
```

Helper:

```text
validateViewerMedia()
```

Current default max:

```text
10 MB
```

Viewer binary data is NOT stored in Durable Object.

Order stores minimal metadata:

```text
media: {
  fileId,
  type,
  mime
}
```

The fee is taken from server-side config at invoice creation and snapshotted into:

```text
mediaFee
totalAmount
```

---

# 10. Secure attachment proxy

Route:

```text
/media/attachment/<fileId>?key=<overlayKey>
```

Protection:

1. request must contain the current `overlayKey`;
2. Worker checks paid `history` for that exact viewer-media `fileId`;
3. only then Worker calls Telegram `getFile`;
4. BOT_TOKEN remains server-side;
5. raw Telegram file URL is not exposed to OBS.

Current implementation authorizes viewer attachment by presence in paid persisted `history`.

This prevents arbitrary unauthenticated Telegram file proxy use.

---

# 11. Alert delay

New config:

```text
alertDelayMs
```

Default:

```text
10000
```

Admin supports `0..120 seconds`.

`playAt` is NOT created at invoice creation.

It is created only after valid `successful_payment` is accepted:

```text
paidAt = Date.now()
playAt = calculatePlayAt(paidAt, cfg.alertDelayMs)
```

`playAt` is saved into the new payment record/alert.

Meaning:

```text
earliest time the alert is eligible to start
```

It is not guaranteed exact playback time because another alert may already be playing.

Later admin delay changes do not recalculate an already-created `playAt`.

---

# 12. successful_payment

Important validation includes:

- order exists;
- invoice payload matches;
- currency is `XTR`;
- total amount matches snapshotted order total;
- Telegram user matches order user;
- `telegram_payment_charge_id` exists.

New payment transaction creates/updates:

```text
order:<payload>
payment:<chargeId>
history
alertSeq
```

The same transaction assigns a monotonic sequence:

```text
seq
```

Alert includes:

```text
id
seq
ts
playAt
payload
user
displayName
amount
baseAmount
ttsFee
mediaFee
totalAmount
comment
tts
media
tier
test
```

Payment record delivery remains:

```text
pending
sent
```

Do not redesign this path without tests.

---

# 13. Payment dedupe / idempotency

Existing project already has:

```text
src/update-dedupe.js
src/payment-receipt.js
```

Normal Telegram messages/callbacks use early dedupe reservation.

Payment-critical events keep payment-specific retry/idempotency semantics.

Permanent payment identity:

```text
payment:<telegram_payment_charge_id>
```

Receipt sending has a claim/complete/fail mechanism to suppress duplicate Telegram thank-you messages.

Any future payment change must include regression tests for duplicate `successful_payment`.

---

# 14. Payment receipt

After successful payment, the viewer receives an approximate alert timing message based on:

```text
cfg.alertDelayMs
```

If delay > 0, message explains the approximate delay and that another currently-playing donation may place the alert in the queue.

Do not promise an exact playback timestamp.

---

# 15. OBS WebSocket

OBS connects to:

```text
/ws?key=<overlayKey>&layout=<landscape|vertical>&mode=alerts
```

Goal uses:

```text
mode=goal
```

The Durable Object:

- authenticates `overlayKey`;
- accepts hibernating WebSocket;
- stores attachment `{layout, mode}`;
- sends `hello`;
- includes recent alert history (up to 100) for alert mode;
- separates alert and goal broadcasts.

Unexpected client messages are rejected.

Heartbeat uses Cloudflare WebSocket auto-response.

---

# 16. Alert queue

Overlay state:

```text
queue[]
known Set
playing boolean
lastSeenSeq
```

New behavior:

- enqueue does NOT immediately persist sequence completion;
- queue checks `playAt`;
- only an eligible alert is started;
- one `playAlert()` executes at a time;
- after successful/fallback completion, its seq is persisted to localStorage;
- then next alert starts.

This prevents the original bug where an alert waiting for `playAt` could be considered seen before it was actually displayed.

## Reconnect

`hello.data.recent` is compared with the locally persisted sequence cursor.

Historical timestamp cursor compatibility is retained via the legacy localStorage key.

Do not replace seq logic with timestamps again.

---

# 17. Audio → TTS sequence

Current overlay order:

```text
render alert
→ play tier sound
→ await sound completion / emergency timeout
→ 300 ms pause
→ TTS
→ keep alert visible
→ hide
→ next queue item
```

Sound and TTS are no longer intentionally started in parallel.

Current emergency audio deadlock timeout in merged code:

```text
10000 ms
```

## CURRENT-CODE NOTE

The 10-second emergency ceiling can end waiting before a legitimate configured sound longer than 10 seconds finishes.

If long tier sounds are intended, future work should change this to:

```text
loaded audio duration + safety margin
```

or a more generous configurable emergency ceiling.

This is not a payment/storage compatibility issue, only overlay playback behavior.

---

# 18. Karaoke / progressive TTS text

Helper:

```text
prepareKaraokeMarkup()
```

Overlay uses:

```text
SpeechSynthesisUtterance.onboundary
```

when available.

Comment words are wrapped with `.k-word`.

Active speech word receives `.active`.

This is progressive enhancement:

- no boundary support → static text;
- TTS failure → queue fallback;
- payment logic does not depend on karaoke.

---

# 19. Viewer media rendering

Tier animation remains in:

```text
.media
```

Viewer attachment is rendered separately in:

```text
.viewer-media
```

Both are placed inside:

```text
.media-wrapper
```

Viewer attachment therefore acts as an addon and does not replace the tier animation.

Current viewer attachment rendering uses `<img>`, matching the supported photo/static-WEBP subset.

---

# 20. Typography

2026-09-09 overlay update increased:

- alert/card dimensions;
- donor headline size;
- comment size;
- vertical layout sizing;
- long-text wrapping.

Main visual hierarchy:

```text
donor name
amount
TTS badge
comment
```

The overlay still supports:

```text
landscape
vertical
```

---

# 21. Config defaults

`normalizeConfigV4()` remains the config compatibility function even though the project package is currently `5.1.0`.

Do not rename it merely for style.

It now normalizes:

```text
ttsProfiles
goal
alertDelayMs
viewerMedia
tiers
amounts
```

Default viewer-media config is additive.

Default alert delay is additive.

Historical order/payment records are not rewritten by config normalization.

---

# 22. Admin controls

Current `/admin` includes:

```text
Animations
Sounds
TTS
Stars amounts
Goal
Balance
Alert delay
Viewer media
Test alert
OBS links
Payment history
OBS-key rotation
```

New controls added by 2026-09-09 update:

```text
alert delay
viewer-media on/off
viewer-media price
```

Do not rotate `overlayKey` as part of unrelated feature development.

---

# 23. OBS media routes

Tier admin media:

```text
/media/animation/<tier>?key=<overlayKey>
/media/sound/<tier>?key=<overlayKey>
```

Viewer attachment:

```text
/media/attachment/<fileId>?key=<overlayKey>
```

All are Worker/DO mediated.

Never embed `BOT_TOKEN` into browser-visible URLs.

---

# 24. History

`history` is a bounded list of recent alerts.

Current code keeps up to:

```text
100
```

WebSocket `hello` also exposes up to 100 recent alerts for replay/reconnect logic.

Do not rewrite old history entries to populate new optional fields.

---

# 25. Refunds

Admin payment history can refund eligible paid orders using:

```text
refundStarPayment
```

Refund uses stored:

```text
userId
telegramPaymentChargeId
```

Refund marks order/payment as refunded.

Old records missing required v5 fields may remain viewable without automatic refund action.

---

# 26. Goal

Existing goal architecture is unchanged by the 2026-09-09 donation enhancements.

Goal WebSocket remains separated from alert WebSocket.

Balance refresh/caching behavior from v5/v5.1 remains intact.

---

# 27. Secrets

Expected runtime secrets:

```text
BOT_TOKEN
TELEGRAM_WEBHOOK_SECRET
CLAIM_SECRET
SETUP_SECRET
```

Legacy transitional fallback:

```text
APP_SECRET
```

Rules:

- never commit secret values;
- never ask user to paste secrets into chat;
- never rotate secrets for unrelated feature changes;
- `overlayKey` is stored in config and is separate from runtime Secrets.

---

# 28. OBS URLs

Existing alert URLs remain compatible:

```text
/overlay/landscape?key=<overlayKey>
/overlay/vertical?key=<overlayKey>
```

Goal:

```text
/goal/landscape?key=<overlayKey>
/goal/vertical?key=<overlayKey>
```

Do not change these route shapes without a backward-compatibility requirement.

---

# 29. Tests

Primary command:

```bash
npm run verify
```

Which runs:

```text
npm test
npm run check
```

Tests live in:

```text
tests/*.test.mjs
```

2026-09-09 added:

```text
tests/enhancements.test.mjs
```

It includes regression coverage for:

- display-name sanitization;
- viewer media photo/static sticker validation;
- rejection of TGS/video/oversize/unsupported media;
- price snapshots;
- baseAmount tier invariant;
- playAt helper;
- legacy config defaults;
- historical order fixture defaults;
- historical payment playAt fallback.

Future feature work should continue TDD:

```text
failing test
→ implementation
→ targeted tests
→ full npm run verify
→ diff review
```

---

# 30. Current relevant files

```text
src/index.js
src/v4-logic.js
src/update-dedupe.js
src/payment-receipt.js
src/overlay-route.js

public/overlay.html
public/overlay-logic.js
public/goal.html

tests/
wrangler.jsonc
package.json
README.md
PROJECT_CONTEXT.md
```

---

# 31. 2026-09-09 feature update summary

Merged through PR #2:

```text
Add donation delay, sequential queue, display name privacy,
viewer media, and price snapshots
```

Implementation commit:

```text
94c4e77
```

Merge commit on main:

```text
a673277
```

Files changed in implementation:

```text
public/overlay-logic.js
public/overlay.html
src/index.js
src/v4-logic.js
tests/enhancements.test.mjs
```

Major behavior added:

- `alertDelayMs`;
- `playAt`;
- strict sequential sound → TTS flow;
- local completion cursor persisted after playback;
- viewer display-name stage;
- `Unknown` anonymous mode;
- viewer photo/static sticker addon;
- 10 MB viewer media limit;
- viewer media pricing snapshot;
- secure viewer attachment proxy;
- tier based on baseAmount;
- separate viewer-media rendering;
- improved typography;
- karaoke boundary highlighting;
- legacy read-time compatibility.

---

# 32. Known/current issues to keep visible

These are current-code notes, not historical migrations.

## A. Default-name privacy

`name:default` currently uses:

```text
formatUser(user)
```

and `formatUser()` prefers `@username`.

This conflicts with the strict desired privacy requirement if that requirement is:

```text
Never expose Telegram @username for any new donation.
```

Recommended future fix:

- default to first_name/last_name only; or
- remove "use Telegram default" option;
- keep Telegram identifiers internal.

## B. Audio emergency timeout

`playAudioSound()` currently has a fixed 10-second emergency timeout.

If a valid tier sound is longer than 10 seconds, TTS can begin before the sound truly ends.

Recommended future fix:

- use loaded duration + margin; or
- increase/configure emergency timeout.

## C. package version/docs naming

`package.json` is still:

```text
5.1.0
```

and its description still references the duplicate-webhook hotfix.

The feature update was merged without a semantic version bump.

Do not silently change package version unless the owner decides whether this should become `5.2.0` or another release number.

---

# 33. Agent instructions for future work

Before changing code:

1. read this file;
2. inspect CURRENT main;
3. run `npm run verify`;
4. current code wins over docs;
5. verify current Telegram Bot API / Cloudflare limits if relevant;
6. identify exact storage/payment compatibility risks.

Do NOT:

- recreate project from scratch;
- bulk migrate old Durable Object data;
- clear storage;
- rewrite historical payments;
- replay old payments;
- rotate secrets unnecessarily;
- change OBS URLs unnecessarily;
- replace Durable Objects/WebSockets without necessity.

For payment-affecting work:

1. write failing regression test first;
2. preserve old records;
3. snapshot configurable price values at order creation;
4. keep `telegram_payment_charge_id` identity;
5. keep duplicate-payment handling idempotent;
6. run full regression suite.

---

# 34. Final source-of-truth rule

This document is a handoff aid, not an authority over the code.

Priority:

```text
CURRENT main code
→ executable tests
→ PROJECT_CONTEXT.md
→ README/comments/old chat summaries
```

If docs and code disagree, document the discrepancy and update docs after code is finalized.
