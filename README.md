# starchik — Telegram Stars → OBS

Готовый Cloudflare Worker для `@ttt_stars_bot`.

## Что умеет

- Telegram Stars (`XTR`) через официальный `sendInvoice` flow.
- Алерт создаётся **только** после `successful_payment`.
- Комментарий пользователя перед оплатой.
- OBS Browser Source: 1920×1080 и TikTok 1080×1920.
- WebSocket realtime + очередь алертов + reconnect.
- `/admin` прямо в Telegram.
- Через админку можно менять суммы, назначать GIF/WebM/MP4/картинки/обычные и video-стикеры, звуки, запускать тестовые алерты, смотреть историю и менять OBS-ключ.
- Файлы не хранятся публично: сохраняется Telegram `file_id`, а Worker проксирует файл в OBS, не раскрывая bot token.
- `/terms` и `/paysupport`.

## Секреты Cloudflare

Нужны только:

- `BOT_TOKEN` — токен из @BotFather.
- `APP_SECRET` — длинный случайный секрет. Он используется для защиты Telegram webhook и одноразового claim владельца.

Не добавляй их в GitHub.

## Деплой

1. Подключи репозиторий в Cloudflare Workers Builds / Git integration.
2. Build command: `npm install`
3. Deploy command: `npx wrangler deploy`
4. После первого deploy открой Worker → Settings → Variables and Secrets и добавь `BOT_TOKEN` и `APP_SECRET` как **Secret**.
5. Сделай redeploy.
6. Открой в браузере:
   `https://ТВОЙ-WORKER.workers.dev/bootstrap?code=APP_SECRET`
7. Страница подключит webhook и команды Telegram.
8. В `@ttt_stars_bot` отправь:
   `/claim APP_SECRET`
9. Затем `/admin` → `🔗 OBS-ссылки`.

## OBS

### Обычный стрим

- Sources → `+` → Browser
- URL: ссылка `1920×1080` из `/admin`
- Width: `1920`
- Height: `1080`
- Shutdown source when not visible: по желанию

### TikTok / вертикальный

- URL: ссылка `1080×1920`
- Width: `1080`
- Height: `1920`

## Анимации и звуки

`/admin` → `🎬 Анимации` или `🔊 Звуки` → выбери диапазон Stars → отправь файл боту.

Поддерживаются для анимаций: GIF/Telegram Animation, MP4, WebM, изображения, статические WEBP-стикеры и video WEBM-стикеры. Telegram `.tgs` animated sticker пока намеренно отклоняется — для OBS лучше отправить GIF/WebM.

## Тест

`/admin` → `🧪 Тест алерта` → выбери уровень. Stars не списываются.

## Безопасность

- Никогда не коммить `BOT_TOKEN` или `APP_SECRET`.
- OBS URL содержит отдельный автоматически сгенерированный ключ.
- Если OBS URL утёк: `/admin` → `🔐 Новый OBS-ключ`.
- После claim другой Telegram-аккаунт не может назначить себя владельцем.
