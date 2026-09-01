# starchik v5.1 — Telegram Stars → OBS (duplicate webhook hotfix)

Cloudflare Worker для `@ttt_stars_bot`.

v5 не меняет основную архитектуру: Telegram Bot API + Cloudflare Workers + один SQLite-backed Durable Object + hibernating WebSockets + OBS Browser Source. Обновление усиливает надёжность платежей, безопасность и reconnect, не сбрасывая текущие настройки Durable Object.

## v5.1 hotfix: почему бот отвечал 4 раза

После v5 Telegram мог одновременно повторить один и тот же webhook Update, а старая защита записывала `update_id` только **после** `sendMessage` / `answerCallbackQuery`. Пока первый запрос ждал Telegram API, ещё несколько retry успевали пройти ту же проверку и каждый отправлял ответ.

v5.1 исправляет это так:

- обычные `message` и `callback_query` получают стабильный fingerprint (`message:<chat>:<message_id>` / `callback:<callback_id>`);
- fingerprint и `update_id` резервируются **атомарно в Durable Object transaction до любых внешних side effects**;
- если Telegram одновременно прислал 4 копии одного Update, только первая обрабатывается, остальные сразу получают `200 { duplicate: true }`;
- старый `processedUpdates` учитывается при миграции, поэтому уже обработанные v5 Update не оживут после deploy;
- `pre_checkout_query`, `successful_payment` и `refunded_payment` специально не блокируются ранней reservation — для них остаётся payment-safe идемпотентность и retry semantics;
- в Cloudflare Logs теперь видны `updateId` и fingerprint для reserved/suppressed Updates.
- thank-you сообщение после `successful_payment` тоже получает атомарный receipt-claim, поэтому параллельные retry не отправят 4 одинаковых «Спасибо».

Никакие существующие Stars, OBS URL, GIF/звуки, TTS, goal, admin ID и Durable Object данные при обновлении не сбрасываются. Новые секреты добавлять или менять для v5.1 не нужно.

## Что изменилось по сравнению с v4

### Платежи

- `pre_checkout_query` теперь подтверждается прямо HTTP-ответом webhook. Нет второго запроса Worker → Telegram перед подтверждением, поэтому меньше риск не уложиться в 10 секунд.
- `successful_payment` повторно проверяет payload, `XTR`, итоговую сумму, Telegram user ID и наличие `telegram_payment_charge_id`.
- Каждый платёж навсегда получает запись `payment:<telegram_payment_charge_id>` вместо rolling-массива последних charge ID.
- Запись платежа, paid-order, history и монотонный `alertSeq` коммитятся одной storage-транзакцией.
- Доставка алерта имеет состояние `pending/sent`. Если Worker упадёт после принятого платежа, повтор webhook сможет закончить доставку без повторного списания.
- Ошибка обработки Telegram webhook теперь возвращает `503`, чтобы Telegram мог повторить Update. Идемпотентность по charge ID защищает от двойной обработки.
- Добавлена поддержка `refunded_payment` и ручного полного `refundStarPayment` из `/admin → Последние платежи` с подтверждением.

### Security

Добавлены отдельные секреты:

- `TELEGRAM_WEBHOOK_SECRET` — только Telegram webhook.
- `CLAIM_SECRET` — только первоначальный claim владельца.
- `SETUP_SECRET` — только `/bootstrap`.
- `BOT_TOKEN` — Telegram Bot API.

`APP_SECRET` оставлен только как временный fallback для безопасного перехода с v4. После миграции его можно удалить.

Webhook во время миграции принимает и новый `TELEGRAM_WEBHOOK_SECRET`, и старый `APP_SECRET`, поэтому добавление новых секретов само по себе не обрывает работающего бота. После повторного `/bootstrap` Telegram начинает отправлять новый secret header.

OBS key остаётся отдельным от Telegram/setup/admin секретов. Public WebSocket не принимает команды от клиента; входящие `ping/pong` обслуживаются Cloudflare Hibernation auto-response без пробуждения Durable Object.

### OBS realtime

- У каждого реального платёжного алерта теперь есть постоянный монотонный `seq`.
- Browser Source хранит `lastSeenSeq`, а не timestamp. Это убирает edge case одинаковых millisecond timestamps.
- При reconnect сервер отдаёт до 100 последних сохранённых алертов; клиент пропускает уже увиденные ID/sequence.
- Alert WebSocket и Goal WebSocket разделены по mode: алерты не рассылаются goal-виджету, goal-update не рассылается alert-overlay.
- Hibernation heartbeat использует `setWebSocketAutoResponse("ping" → "pong")`.

### Goal

- Realtime остаётся через WebSocket.
- Fallback-сверка `getMyStarBalance` теперь раз в 120 секунд вместо принудительного запроса каждые 30 секунд.
- Публичный `/goal-state` больше не может принудительно обходить cache через `refresh=1`.
- После payment/refund и ручного admin refresh баланс всё равно обновляется сразу.
- После refund/withdrawal очередная синхронизация показывает реальный уменьшившийся доступный Stars-баланс.

### TTS

- Модель оплаты не меняется: TTS fee прибавляется к invoice total, а animation tier считается только по `baseAmount`.
- Алерт продолжает ждать окончания речи/времени чтения длинного комментария.
- Ошибки `SpeechSynthesis` больше не проглатываются молча: причина пишется в console и показывается в `debug=1`, при этом текст остаётся на экране по безопасному fallback.

### Storage / Free Tier

- Неоплаченные invoice старше 7 дней лениво удаляются (не чаще одного cleanup примерно в 6 часов).
- Создание invoice имеет небольшой per-user cooldown 1.5 секунды против спама.
- Static Assets больше не гоняются через Worker без необходимости: `run_worker_first` ограничен API/overlay route patterns.
- Wrangler закреплён на конкретной версии `4.127.1`.
- `npm run verify` запускает тесты и syntax-check.

## Обновление с v4 без простоя

### Шаг 1. Код

1. Загрузи содержимое v5 поверх файлов текущего GitHub-репозитория.
2. Commit changes.
3. Дождись успешного Cloudflare deployment.

На этом этапе бот продолжит работать через старый `APP_SECRET` fallback. Старые OBS URL, GIF/звуки, TTS-настройки, goal, admin ID и история в Durable Object сохраняются.

### Шаг 2. Добавить три runtime Secret в Cloudflare

В Worker → **Settings → Variables and Secrets** добавь **Secret**:

- `TELEGRAM_WEBHOOK_SECRET`
- `CLAIM_SECRET`
- `SETUP_SECRET`

Для каждого используй отдельную длинную случайную строку. Не используй один и тот же секрет три раза и не клади значения в GitHub.

На Windows можно сгенерировать каждое значение отдельно в PowerShell:

```powershell
[guid]::NewGuid().ToString("N") + [guid]::NewGuid().ToString("N")
```

`BOT_TOKEN` уже существует — его не меняй, если он не утекал.

### Шаг 3. Переключить Telegram webhook на отдельный secret

После сохранения новых секретов один раз открой:

```text
https://telegram-stars-obs.sultanov-tab.workers.dev/bootstrap?code=ТВОЙ_SETUP_SECRET
```

Страница должна показать `Dedicated security secrets active`.

Владелец уже claimed, поэтому повторный `/claim` не нужен. Если это новая установка, используй `/claim ТВОЙ_CLAIM_SECRET`.

После успешного bootstrap можно удалить старый `APP_SECRET` из runtime Variables and Secrets. Сначала убедись, что `/start`, тестовый alert и Stars payment работают.

## Cloudflare Build

Рекомендуемый Build command:

```bash
npm install && npm run verify
```

Deploy command можно оставить:

```bash
npx wrangler deploy
```

## Refunds

`/admin → 📋 Последние платежи` показывает кнопки возврата для последних оплаченных v5-платежей. Нажатие сначала показывает подтверждение, затем вызывает Telegram `refundStarPayment`.

Старые v4-платежи остаются в истории, но если старый history item не содержит v5 `payload`, кнопка автоматического refund для него не показывается.

## OBS

Старые alert URL остаются рабочими. Менять Browser Source после обновления не нужно.

Goal URL тоже остаются прежними.

Для диагностики overlay можно использовать:

```text
&debug=1
```

Для локального preview алерта:

```text
&preview=1
```

Для preview с TTS:

```text
&preview=1&tts=1&debug=1
```

## Что специально НЕ добавлено

Не нужны D1, Workers KV, Supabase, Pusher/Ably или VPS. Для одного стримера текущий SQLite-backed Durable Object даёт strongly-consistent state, payment idempotency и realtime WebSockets в одной архитектуре без дополнительной инфраструктуры.
