# starchik — Telegram Stars → OBS

`starchik` — система донатов через Telegram Stars с realtime-алертами для OBS Browser Source.

Текущая кодовая база сохраняет архитектуру:

**Telegram Bot API → Cloudflare Worker → один SQLite-backed Durable Object (`StreamHub`) → WebSocket → OBS Browser Source**

Текущий `package.json` по-прежнему содержит версию `5.1.0`, но `main` уже включает функциональное обновление от 2026-09-09: задержка алертов, последовательная очередь, публичное имя донатера, платные медиа-вложения, price snapshots и обновлённый TTS/overlay.

---

## Возможности

### Telegram Stars payments

- Оплата цифровой услуги через Telegram Stars (`XTR`).
- Реальный OBS alert создаётся только после подтверждённого `successful_payment`.
- `pre_checkout_query` повторно проверяет заказ, валюту, сумму и пользователя.
- Платёж идентифицируется через `telegram_payment_charge_id`.
- Payment/order/history сохраняются в Durable Object.
- Повторные Telegram webhook Updates и payment retries защищены существующей idempotency/deduplication логикой.
- Поддерживается возврат через Telegram `refundStarPayment`.

### Donation flow

Актуальный viewer flow:

```text
Сумма
→ публичное имя
→ комментарий
→ TTS
→ опциональное фото/стикер
→ Telegram Stars invoice
→ successful_payment
→ playAt
→ OBS queue
```

### Публичное имя

Для новых донатов в order сохраняется `displayName`.

Пользователь может:

- ввести собственное публичное имя;
- выбрать анонимный вариант → `Unknown`;
- использовать предложенное ботом имя.

Имя санитизируется и ограничивается 30 символами.

> Важно: текущая кнопка «использовать имя по умолчанию» использует существующий `formatUser()`, который при наличии Telegram username может вернуть `@username`. Если нужен строгий режим «никогда не показывать Telegram username новым донатам», это место следует дополнительно изменить.

Старые order/history без `displayName` не мигрируются и продолжают читаться через исторический fallback.

### Snapshot pricing

Стоимость фиксируется при создании invoice.

В order сохраняются:

- `baseAmount`;
- `ttsFee`;
- `mediaFee`;
- `totalAmount`;
- snapshot выбранного TTS;
- snapshot viewer media metadata;
- `displayName`.

Изменение цены TTS/медиа в `/admin` после создания invoice не должно менять существующий order.

Animation tier рассчитывается **только по `baseAmount`**.

Пример:

```text
baseAmount = 100
ttsFee     = 10
mediaFee   = 25
total      = 135
```

Пользователь платит `135 ⭐`, но tier остаётся tier для `100 ⭐`.

---

## Задержка алерта

В config есть:

```text
alertDelayMs
```

Default:

```text
10000 ms
```

`playAt` создаётся только после принятого `successful_payment`:

```text
playAt = paidAt + alertDelayMs
```

Это **earliest playback time**, а не обещание точного времени появления.

Если другой alert уже проигрывается, новый остаётся в очереди.

В `/admin` задержку можно менять в диапазоне `0–120` секунд.

---

## OBS queue и audio/TTS

Overlay проигрывает alerts последовательно.

Базовая последовательность:

```text
alert eligible by playAt
→ показать tier animation + текст
→ проиграть tier sound
→ дождаться sound completion
→ небольшая пауза
→ TTS
→ завершить alert
→ следующий alert
```

Sound и TTS больше не должны запускаться параллельно.

Для audio есть аварийный timeout, чтобы битый media asset не зависил всю очередь.

Sequence cursor (`lastSeenSeq`) сохраняется после завершения `playAlert()`, а не в момент enqueue, чтобы reload во время ожидания `playAt` не терял ещё не проигранный alert.

---

## Karaoke TTS

Если OBS/browser поддерживает `SpeechSynthesisUtterance.onboundary`, comment разбивается на слова и активное слово подсвечивается во время речи.

Это progressive enhancement:

- если boundary events работают → karaoke-подсветка;
- если не работают → обычный статический текст;
- payment/queue логика не зависит от karaoke.

---

## Viewer media

Админ может включить платное media-вложение.

Config:

```text
viewerMedia.enabled
viewerMedia.price
viewerMedia.allowPhoto
viewerMedia.allowSticker
viewerMedia.maxBytes
```

Defaults:

```text
enabled      = false
price        = 25 Stars
allowPhoto   = true
allowSticker = true
maxBytes     = 10 MB
```

Поддерживается:

- Telegram photo;
- обычный статический WEBP sticker.

Отклоняется:

- TGS animated sticker;
- video sticker;
- неподдерживаемые документы/типы;
- файл больше `10 MB`.

Viewer media не хранится бинарно в Durable Object. В order хранится только минимальная metadata (`fileId`, type, mime и т. п.).

### Secure media proxy

OBS получает viewer media через:

```text
/media/attachment/<fileId>?key=<overlayKey>
```

Route:

- требует правильный `overlayKey`;
- проверяет, что `fileId` присутствует в оплаченной history;
- получает файл через Telegram Bot API на стороне Worker;
- не отдаёт `BOT_TOKEN` клиенту;
- не отдаёт raw Telegram file URL.

Viewer attachment показывается **дополнительно к tier animation**, а не вместо неё.

---

## Admin

`/admin` управляет:

- tier animations;
- tier sounds;
- TTS profiles и ценами;
- preset/custom Stars amounts;
- goal widget;
- alert delay;
- viewer media enable/disable;
- viewer media price;
- test alerts;
- OBS links;
- payment history / refunds;
- rotation of OBS overlay key.

Секреты Cloudflare не меняются через эти новые функции.

---

## OBS URLs

Существующие URL остаются совместимыми.

Alerts:

```text
/overlay/landscape?key=<overlayKey>
/overlay/vertical?key=<overlayKey>
```

Goal:

```text
/goal/landscape?key=<overlayKey>
/goal/vertical?key=<overlayKey>
```

Дополнительные параметры:

```text
&debug=1
&preview=1
&preview=1&tts=1&debug=1
```

Не публикуйте URL с `overlayKey`.

---

## Storage compatibility

Новые функции сделаны аддитивно.

Существующие исторические:

- `order:*`;
- `payment:*`;
- `history`;
- `overlayKey`;
- admin ID;
- tiers;
- sounds;
- animations;
- OBS URLs

не требуют bulk migration.

Read-time/default compatibility:

```text
missing displayName → historical fallback
missing media       → no viewer media
missing mediaFee    → 0
missing playAt      → historical timestamp/default behavior
```

Config при чтении нормализуется и получает defaults для новых config fields.

---

## Security

Runtime secrets:

- `BOT_TOKEN`
- `TELEGRAM_WEBHOOK_SECRET`
- `CLAIM_SECRET`
- `SETUP_SECRET`

Legacy migration fallback:

- `APP_SECRET`

`overlayKey` — отдельный OBS access key и не является Telegram/Cloudflare setup secret.

Никогда не коммитьте реальные secret values в GitHub.

---

## Cloudflare

Worker name:

```text
telegram-stars-obs
```

Основное состояние живёт в одном Durable Object:

```text
StreamHub
idFromName("starchik-main")
```

Используются hibernating WebSockets и WebSocket auto-response для heartbeat.

Никакие D1 / Workers KV / Supabase / Pusher / отдельный VPS для текущей архитектуры не требуются.

---

## Tests

```bash
npm install
npm run verify
```

`npm run verify`:

1. запускает все `tests/*.test.mjs`;
2. выполняет syntax-check основных Worker modules.

После обновления 2026-09-09 добавлен `tests/enhancements.test.mjs`, который проверяет, в частности:

- display-name sanitization;
- viewer media validation;
- snapshot pricing;
- baseAmount tier invariant;
- `playAt`;
- defaults для старого config;
- compatibility исторических order/payment fixtures.

---

## Deployment

Рекомендуемый Cloudflare Build command:

```bash
npm install && npm run verify
```

Deploy:

```bash
npx wrangler deploy
```

Перед production deploy:

1. `npm run verify`;
2. проверить diff;
3. не менять secrets без необходимости;
4. не удалять/мигрировать исторические payment/order/history;
5. сделать тестовый alert;
6. проверить один реальный/тестовый payment flow;
7. проверить OBS landscape/vertical;
8. проверить TTS и viewer media.

---

## Source of truth

**Код текущего `main` важнее README/PROJECT_CONTEXT.**

Если документация расходится с кодом:

1. сначала изучить актуальный `main`;
2. запустить tests;
3. считать код текущим состоянием;
4. после реализации обновить документацию.

Текущий feature merge: PR #2, `Add donation delay, sequential queue, display name privacy, viewer media, and price snapshots` (2026-09-09).
