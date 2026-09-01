import { DurableObject } from "cloudflare:workers";
import { overlayAssetUrl } from "./overlay-route.js";

const DEFAULT_AMOUNTS = [10, 25, 50, 100, 250, 500, 1000];
const MAX_COMMENT = 140;
const MAX_CUSTOM_STARS = 10000;

const DEFAULT_TIERS = [
  { label: "1–24 ⭐", min: 1, max: 24, duration: 6000, animation: null, sound: null },
  { label: "25–99 ⭐", min: 25, max: 99, duration: 6500, animation: null, sound: null },
  { label: "100–249 ⭐", min: 100, max: 249, duration: 7000, animation: null, sound: null },
  { label: "250–499 ⭐", min: 250, max: 499, duration: 7500, animation: null, sound: null },
  { label: "500–999 ⭐", min: 500, max: 999, duration: 8500, animation: null, sound: null },
  { label: "1000+ ⭐", min: 1000, max: 1000000000, duration: 10000, animation: null, sound: null }
];

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers }
  });
}

function html(body, status = 200) {
  return new Response(body, {
    status,
    headers: { "content-type": "text/html; charset=utf-8" }
  });
}

function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function randomToken(bytes = 24) {
  const data = new Uint8Array(bytes);
  crypto.getRandomValues(data);
  return Array.from(data, b => b.toString(16).padStart(2, "0")).join("");
}

function callbackButton(text, data) {
  return { text, callback_data: data };
}

function formatUser(user = {}) {
  if (user.username) return `@${user.username}`;
  const full = [user.first_name, user.last_name].filter(Boolean).join(" ").trim();
  return full || `user_${user.id ?? "unknown"}`;
}

function chunkButtons(items, perRow = 3) {
  const rows = [];
  for (let i = 0; i < items.length; i += perRow) rows.push(items.slice(i, i + perRow));
  return rows;
}

async function resolveSecret(env, name) {
  const value = env?.[name];
  if (typeof value === "string") return value;
  if (value && typeof value.get === "function") {
    const resolved = await value.get();
    return typeof resolved === "string" ? resolved : "";
  }
  return "";
}

async function tg(env, method, body = {}) {
  const botToken = await resolveSecret(env, "BOT_TOKEN");
  if (!botToken) throw new Error("BOT_TOKEN secret is missing");
  const response = await fetch(`https://api.telegram.org/bot${botToken}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.ok) {
    const detail = payload?.description || `${response.status} ${response.statusText}`;
    throw new Error(`Telegram ${method}: ${detail}`);
  }
  return payload.result;
}

async function getTelegramFile(env, fileId) {
  const info = await tg(env, "getFile", { file_id: fileId });
  if (!info?.file_path) throw new Error("Telegram did not return file_path");
  const botToken = await resolveSecret(env, "BOT_TOKEN");
  if (!botToken) throw new Error("BOT_TOKEN secret is missing");
  const source = await fetch(`https://api.telegram.org/file/bot${botToken}/${info.file_path}`);
  if (!source.ok) throw new Error(`Telegram file download failed: ${source.status}`);
  return source;
}

function mainMenu(amounts) {
  const amountButtons = amounts.map(n => callbackButton(`${n} ⭐`, `donate:${n}`));
  return {
    inline_keyboard: [
      ...chunkButtons(amountButtons, 3),
      [callbackButton("✏️ Своя сумма", "donate:custom")],
      [callbackButton("📄 Условия", "terms"), callbackButton("🆘 Поддержка", "support")]
    ]
  };
}

function termsText(brand) {
  return [
    `📄 Условия поддержки ${brand}`,
    "",
    "Stars используются для покупки цифровой услуги: показа сообщения/алерта на стриме.",
    "",
    "• Алерт запускается только после подтверждённого Telegram successful_payment.",
    "• Сообщения могут не отображаться или быть скрыты, если нарушают правила платформы/стрима.",
    "• При техническом сбое напишите /paysupport — мы проверим платёж по Telegram charge ID.",
    "• Оплату обрабатывает Telegram. По спорным платежам обращайтесь владельцу бота через /paysupport.",
    "",
    "Продолжая оплату, вы подтверждаете, что прочитали и принимаете эти условия."
  ].join("\n");
}

function adminMenu() {
  return {
    inline_keyboard: [
      [callbackButton("🎬 Анимации", "adm:animations"), callbackButton("🔊 Звуки", "adm:sounds")],
      [callbackButton("⭐ Суммы", "adm:amounts"), callbackButton("🧪 Тест алерта", "adm:test")],
      [callbackButton("🔗 OBS-ссылки", "adm:links"), callbackButton("📋 Последние платежи", "adm:history")],
      [callbackButton("🔐 Новый OBS-ключ", "adm:rotate")]
    ]
  };
}

function tierKeyboard(prefix, tiers) {
  return {
    inline_keyboard: [
      ...chunkButtons(tiers.map((t, i) => callbackButton(t.label, `${prefix}:${i}`)), 2),
      [callbackButton("⬅️ Админка", "adm:home")]
    ]
  };
}

function mediaFromMessage(message, kind) {
  if (kind === "animation") {
    if (message.animation) {
      return {
        fileId: message.animation.file_id,
        mime: message.animation.mime_type || "video/mp4",
        name: message.animation.file_name || "animation"
      };
    }
    if (message.sticker) {
      if (message.sticker.is_animated) return { error: "TGS-стикеры пока не поддерживаются. Отправь GIF, WebM, MP4 или обычный/видео-стикер." };
      return {
        fileId: message.sticker.file_id,
        mime: message.sticker.is_video ? "video/webm" : "image/webp",
        name: "sticker"
      };
    }
    if (message.video) {
      return { fileId: message.video.file_id, mime: message.video.mime_type || "video/mp4", name: message.video.file_name || "video" };
    }
    if (message.photo?.length) {
      const p = message.photo[message.photo.length - 1];
      return { fileId: p.file_id, mime: "image/jpeg", name: "photo" };
    }
    if (message.document) {
      const mime = message.document.mime_type || "application/octet-stream";
      if (!mime.startsWith("image/") && !mime.startsWith("video/")) return null;
      return { fileId: message.document.file_id, mime, name: message.document.file_name || "document" };
    }
  }

  if (kind === "sound") {
    if (message.audio) {
      return { fileId: message.audio.file_id, mime: message.audio.mime_type || "audio/mpeg", name: message.audio.file_name || "audio" };
    }
    if (message.voice) {
      return { fileId: message.voice.file_id, mime: message.voice.mime_type || "audio/ogg", name: "voice" };
    }
    if (message.document?.mime_type?.startsWith("audio/")) {
      return { fileId: message.document.file_id, mime: message.document.mime_type, name: message.document.file_name || "audio" };
    }
  }
  return null;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = url.origin;
    const id = env.HUB.idFromName("starchik-main");
    const hub = env.HUB.get(id);

    if (url.pathname === "/health") {
      return json({ ok: true, service: "starchik", bot: `@${env.BOT_USERNAME}` });
    }

    if (url.pathname === "/bootstrap") {
      const code = url.searchParams.get("code") || "";
      const appSecret = await resolveSecret(env, "APP_SECRET");
      const botToken = await resolveSecret(env, "BOT_TOKEN");
      if (!appSecret || code !== appSecret) return html("<h1>403</h1><p>Wrong setup code.</p>", 403);
      if (!botToken) return html("<h1>BOT_TOKEN is missing</h1>", 500);

      const webhookUrl = `${origin}/telegram`;
      const webhookResult = await tg(env, "setWebhook", {
        url: webhookUrl,
        secret_token: appSecret,
        allowed_updates: ["message", "callback_query", "pre_checkout_query"]
      });
      await tg(env, "setMyCommands", {
        commands: [
          { command: "start", description: "Поддержать стрим Stars" },
          { command: "admin", description: "Админ-панель" },
          { command: "terms", description: "Условия оплаты" },
          { command: "paysupport", description: "Помощь с платежом" }
        ]
      });

      return html(`<!doctype html><meta charset="utf-8"><title>starchik setup</title>
      <style>body{font-family:system-ui;background:#0d1020;color:#fff;max-width:720px;margin:60px auto;padding:24px}code{background:#1b2140;padding:3px 7px;border-radius:7px}.ok{color:#82ffa1}</style>
      <h1 class="ok">✓ Webhook подключён</h1>
      <p>Telegram ответил: <code>${escapeHtml(String(webhookResult))}</code></p>
      <p>Теперь открой <b>@${escapeHtml(env.BOT_USERNAME)}</b> и отправь:</p>
      <p><code>/claim ${escapeHtml(appSecret)}</code></p>
      <p>После успешного claim команда повторно владельца не сменит.</p>`);
    }

    if (url.pathname === "/telegram") {
      if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
      const secret = request.headers.get("X-Telegram-Bot-Api-Secret-Token") || "";
      const appSecret = await resolveSecret(env, "APP_SECRET");
      if (!appSecret || secret !== appSecret) return new Response("Forbidden", { status: 403 });
      const headers = new Headers(request.headers);
      headers.set("x-worker-origin", origin);
      const forwarded = new Request("https://hub.internal/telegram", {
        method: "POST",
        headers,
        body: request.body
      });
      return hub.fetch(forwarded);
    }

    if (url.pathname === "/ws" || url.pathname.startsWith("/media/") || url.pathname === "/status") {
      const headers = new Headers(request.headers);
      headers.set("x-worker-origin", origin);
      return hub.fetch(new Request(`https://hub.internal${url.pathname}${url.search}`, {
        method: request.method,
        headers,
        body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body
      }));
    }

    if (url.pathname === "/overlay/landscape" || url.pathname === "/overlay/vertical") {
      const assetUrl = overlayAssetUrl(request.url);
      const assetRequest = new Request(assetUrl, request);
      return env.ASSETS.fetch(assetRequest);
    }

    return env.ASSETS.fetch(request);
  }
};

export class StreamHub extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
    this.env = env;
  }

  async config() {
    let cfg = await this.ctx.storage.get("config");
    if (!cfg) {
      cfg = {
        overlayKey: randomToken(24),
        amounts: DEFAULT_AMOUNTS,
        tiers: structuredClone(DEFAULT_TIERS),
        origin: null
      };
      await this.ctx.storage.put("config", cfg);
    }
    return cfg;
  }

  async saveConfig(cfg) {
    await this.ctx.storage.put("config", cfg);
  }

  async isAdmin(userId) {
    const adminId = await this.ctx.storage.get("adminUserId");
    return adminId && Number(adminId) === Number(userId);
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/telegram") return this.handleTelegram(request);
    if (url.pathname === "/ws") return this.handleWebSocket(request);
    if (url.pathname.startsWith("/media/")) return this.handleMedia(request);
    if (url.pathname === "/status") return this.handleStatus(request);
    return new Response("Not Found", { status: 404 });
  }

  async handleStatus(request) {
    const cfg = await this.config();
    const key = new URL(request.url).searchParams.get("key");
    if (key !== cfg.overlayKey) return json({ ok: false }, 403);
    return json({ ok: true, brand: this.env.BRAND_NAME, tiers: cfg.tiers.map(t => ({ label: t.label, duration: t.duration, hasAnimation: !!t.animation, hasSound: !!t.sound })) });
  }

  async handleWebSocket(request) {
    const url = new URL(request.url);
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return new Response("Expected websocket", { status: 426 });
    const cfg = await this.config();
    if (url.searchParams.get("key") !== cfg.overlayKey) return new Response("Forbidden", { status: 403 });

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    const layout = url.searchParams.get("layout") === "vertical" ? "vertical" : "landscape";
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ layout });

    const history = (await this.ctx.storage.get("history")) || [];
    server.send(JSON.stringify({
      type: "hello",
      data: {
        brand: this.env.BRAND_NAME,
        layout,
        recent: history.slice(-20),
        tiers: cfg.tiers.map((t, i) => ({ index: i, label: t.label, duration: t.duration, hasAnimation: !!t.animation, hasSound: !!t.sound }))
      }
    }));

    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(ws, message) {
    if (String(message) === "ping") ws.send("pong");
  }

  webSocketClose(ws) {
    try { ws.close(1000, "closed"); } catch {}
  }

  async handleMedia(request) {
    const url = new URL(request.url);
    const cfg = await this.config();
    if (url.searchParams.get("key") !== cfg.overlayKey) return new Response("Forbidden", { status: 403 });

    const parts = url.pathname.split("/").filter(Boolean);
    const kind = parts[1];
    const index = Number(parts[2]);
    if (!Number.isInteger(index) || !cfg.tiers[index] || !["animation", "sound"].includes(kind)) return new Response("Not Found", { status: 404 });
    const media = cfg.tiers[index][kind];
    if (!media?.fileId) return new Response("Not Found", { status: 404 });

    try {
      const source = await getTelegramFile(this.env, media.fileId);
      const headers = new Headers();
      headers.set("content-type", media.mime || source.headers.get("content-type") || "application/octet-stream");
      headers.set("cache-control", "private, max-age=300");
      headers.set("x-content-type-options", "nosniff");
      const length = source.headers.get("content-length");
      if (length) headers.set("content-length", length);
      return new Response(source.body, { status: 200, headers });
    } catch (error) {
      return new Response(`Media unavailable: ${error.message}`, { status: 502 });
    }
  }

  async handleTelegram(request) {
    const update = await request.json().catch(() => null);
    if (!update) return json({ ok: false }, 400);

    const origin = request.headers.get("x-worker-origin");
    const cfg = await this.config();
    if (origin && cfg.origin !== origin) {
      cfg.origin = origin;
      await this.saveConfig(cfg);
    }

    try {
      if (update.pre_checkout_query) {
        await this.handlePreCheckout(update.pre_checkout_query);
        return json({ ok: true });
      }

      const processed = (await this.ctx.storage.get("processedUpdates")) || [];
      if (processed.includes(update.update_id)) return json({ ok: true, duplicate: true });

      if (update.callback_query) await this.handleCallback(update.callback_query);
      if (update.message) await this.handleMessage(update.message);

      processed.push(update.update_id);
      if (processed.length > 200) processed.splice(0, processed.length - 200);
      await this.ctx.storage.put("processedUpdates", processed);
      return json({ ok: true });
    } catch (error) {
      console.error("Telegram update failed", error);
      return json({ ok: false, error: String(error?.message || error) }, 200);
    }
  }

  async handleMessage(message) {
    const user = message.from;
    if (!user || message.chat?.type !== "private") return;
    const text = (message.text || "").trim();
    const userId = user.id;

    if (message.successful_payment) {
      await this.handleSuccessfulPayment(message);
      return;
    }

    if (text.startsWith("/claim")) {
      const current = await this.ctx.storage.get("adminUserId");
      if (current) {
        await tg(this.env, "sendMessage", { chat_id: userId, text: Number(current) === Number(userId) ? "✅ Ты уже владелец бота. Используй /admin." : "⛔ Владелец уже назначен." });
        return;
      }
      const code = text.split(/\s+/).slice(1).join(" ");
      const appSecret = await resolveSecret(this.env, "APP_SECRET");
      if (!appSecret || code !== appSecret) {
        await tg(this.env, "sendMessage", { chat_id: userId, text: "⛔ Неверный код владельца." });
        return;
      }
      await this.ctx.storage.put("adminUserId", userId);
      await tg(this.env, "sendMessage", { chat_id: userId, text: `✅ Готово. Аккаунт ${formatUser(user)} назначен владельцем ${this.env.BRAND_NAME}.`, reply_markup: adminMenu() });
      return;
    }

    if (text === "/admin" || text.startsWith("/admin@")) {
      if (!(await this.isAdmin(userId))) {
        await tg(this.env, "sendMessage", { chat_id: userId, text: "⛔ Эта команда доступна только владельцу." });
        return;
      }
      await tg(this.env, "sendMessage", { chat_id: userId, text: `⚙️ Админ-панель ${this.env.BRAND_NAME}`, reply_markup: adminMenu() });
      return;
    }

    if (text === "/terms" || text.startsWith("/terms@")) {
      await tg(this.env, "sendMessage", { chat_id: userId, text: termsText(this.env.BRAND_NAME), reply_markup: { inline_keyboard: [[callbackButton("✅ Принимаю условия", "accept_terms")], [callbackButton("⭐ К поддержке", "menu")]] } });
      return;
    }

    if (text === "/paysupport" || text === "/support" || text.startsWith("/paysupport@")) {
      await this.ctx.storage.put(`pending:${userId}`, { stage: "support" });
      await tg(this.env, "sendMessage", { chat_id: userId, text: "🆘 Опиши проблему с платежом одним сообщением. Я передам её владельцу бота. Если есть — укажи сумму Stars и примерное время оплаты." });
      return;
    }

    if (text === "/start" || text.startsWith("/start@")) {
      const cfg = await this.config();
      await tg(this.env, "sendMessage", {
        chat_id: userId,
        text: `⭐ Поддержать ${this.env.BRAND_NAME}\n\nВыбери количество Stars. После оплаты твоё имя, сумма и комментарий появятся на стриме.`,
        reply_markup: mainMenu(cfg.amounts)
      });
      return;
    }

    const adminAction = await this.ctx.storage.get(`adminAction:${userId}`);
    if (adminAction && (await this.isAdmin(userId))) {
      if (adminAction.type === "amounts") {
        const values = text.split(/[ ,;]+/).map(Number).filter(Number.isFinite).map(Math.trunc);
        const unique = [...new Set(values)].filter(v => v >= 1 && v <= MAX_CUSTOM_STARS).sort((a, b) => a - b);
        if (unique.length < 2 || unique.length > 12) {
          await tg(this.env, "sendMessage", { chat_id: userId, text: "Нужно от 2 до 12 сумм, например:\n10, 25, 50, 100, 250, 500, 1000" });
          return;
        }
        const cfg = await this.config();
        cfg.amounts = unique;
        await this.saveConfig(cfg);
        await this.ctx.storage.delete(`adminAction:${userId}`);
        await tg(this.env, "sendMessage", { chat_id: userId, text: `✅ Суммы сохранены: ${unique.join(" / ")} ⭐`, reply_markup: adminMenu() });
        return;
      }

      if (["animation", "sound"].includes(adminAction.type)) {
        const media = mediaFromMessage(message, adminAction.type);
        if (media?.error) {
          await tg(this.env, "sendMessage", { chat_id: userId, text: `⚠️ ${media.error}` });
          return;
        }
        if (!media) {
          await tg(this.env, "sendMessage", { chat_id: userId, text: adminAction.type === "animation" ? "Отправь GIF, WebM/MP4, картинку или обычный/видео-стикер." : "Отправь MP3/OGG/WAV как аудио, voice или документ." });
          return;
        }
        const cfg = await this.config();
        cfg.tiers[adminAction.tier][adminAction.type] = media;
        await this.saveConfig(cfg);
        await this.ctx.storage.delete(`adminAction:${userId}`);
        await tg(this.env, "sendMessage", { chat_id: userId, text: `✅ ${adminAction.type === "animation" ? "Анимация" : "Звук"} назначен для ${cfg.tiers[adminAction.tier].label}.`, reply_markup: adminMenu() });
        return;
      }
    }

    const pending = await this.ctx.storage.get(`pending:${userId}`);
    if (!pending) {
      const cfg = await this.config();
      await tg(this.env, "sendMessage", { chat_id: userId, text: "Выбери сумму Stars 👇", reply_markup: mainMenu(cfg.amounts) });
      return;
    }

    if (pending.stage === "support") {
      const adminId = await this.ctx.storage.get("adminUserId");
      if (adminId) {
        await tg(this.env, "sendMessage", {
          chat_id: adminId,
          text: `🆘 Запрос по оплате\nОт: ${formatUser(user)} (ID ${userId})\n\n${text.slice(0, 1500)}`
        });
        await tg(this.env, "sendMessage", { chat_id: userId, text: "✅ Сообщение передано владельцу. Ответ придёт через Telegram, когда он его обработает." });
      } else {
        await tg(this.env, "sendMessage", { chat_id: userId, text: "⚠️ Владелец ещё не завершил настройку бота. Попробуй позже." });
      }
      await this.ctx.storage.delete(`pending:${userId}`);
      return;
    }

    if (pending.stage === "custom") {
      const amount = Number(text.replace(/[^0-9]/g, ""));
      if (!Number.isInteger(amount) || amount < 1 || amount > MAX_CUSTOM_STARS) {
        await tg(this.env, "sendMessage", { chat_id: userId, text: `Введи целое число от 1 до ${MAX_CUSTOM_STARS} ⭐.` });
        return;
      }
      await this.ctx.storage.put(`pending:${userId}`, { stage: "comment", amount });
      await this.askComment(userId, amount);
      return;
    }

    if (pending.stage === "comment") {
      const comment = text.slice(0, MAX_COMMENT);
      await this.createInvoice(user, pending.amount, comment);
      await this.ctx.storage.delete(`pending:${userId}`);
      return;
    }
  }

  async handleCallback(query) {
    const user = query.from;
    const userId = user.id;
    const data = query.data || "";
    await tg(this.env, "answerCallbackQuery", { callback_query_id: query.id }).catch(() => {});

    if (data === "menu") {
      const cfg = await this.config();
      await tg(this.env, "sendMessage", { chat_id: userId, text: "⭐ Выбери сумму:", reply_markup: mainMenu(cfg.amounts) });
      return;
    }

    if (data === "terms") {
      await tg(this.env, "sendMessage", { chat_id: userId, text: termsText(this.env.BRAND_NAME), reply_markup: { inline_keyboard: [[callbackButton("✅ Принимаю условия", "accept_terms")]] } });
      return;
    }

    if (data === "support") {
      await this.ctx.storage.put(`pending:${userId}`, { stage: "support" });
      await tg(this.env, "sendMessage", { chat_id: userId, text: "🆘 Опиши проблему с платежом одним сообщением." });
      return;
    }

    if (data === "accept_terms") {
      await this.ctx.storage.put(`terms:${userId}`, { acceptedAt: Date.now() });
      const pending = await this.ctx.storage.get(`pending:${userId}`);
      await tg(this.env, "sendMessage", { chat_id: userId, text: "✅ Условия приняты." });
      if (pending?.stage === "terms" && pending.intended) {
        await this.ctx.storage.delete(`pending:${userId}`);
        await this.beginDonation(userId, pending.intended);
      } else {
        const cfg = await this.config();
        await tg(this.env, "sendMessage", { chat_id: userId, text: "Теперь выбери сумму Stars:", reply_markup: mainMenu(cfg.amounts) });
      }
      return;
    }

    if (data.startsWith("donate:")) {
      const intended = data.split(":")[1];
      const accepted = await this.ctx.storage.get(`terms:${userId}`);
      if (!accepted) {
        await this.ctx.storage.put(`pending:${userId}`, { stage: "terms", intended });
        await tg(this.env, "sendMessage", { chat_id: userId, text: termsText(this.env.BRAND_NAME), reply_markup: { inline_keyboard: [[callbackButton("✅ Принимаю и продолжаю", "accept_terms")], [callbackButton("❌ Отмена", "menu")]] } });
        return;
      }
      await this.beginDonation(userId, intended);
      return;
    }

    if (data === "comment:skip") {
      const pending = await this.ctx.storage.get(`pending:${userId}`);
      if (pending?.stage === "comment") {
        await this.createInvoice(user, pending.amount, "");
        await this.ctx.storage.delete(`pending:${userId}`);
      }
      return;
    }

    if (data === "cancel") {
      await this.ctx.storage.delete(`pending:${userId}`);
      await tg(this.env, "sendMessage", { chat_id: userId, text: "Отменено." });
      return;
    }

    if (!data.startsWith("adm:")) return;
    if (!(await this.isAdmin(userId))) {
      await tg(this.env, "sendMessage", { chat_id: userId, text: "⛔ Только для владельца." });
      return;
    }

    const cfg = await this.config();
    const parts = data.split(":");
    const action = parts[1];

    if (action === "home") {
      await tg(this.env, "sendMessage", { chat_id: userId, text: `⚙️ Админ-панель ${this.env.BRAND_NAME}`, reply_markup: adminMenu() });
    } else if (action === "animations") {
      await tg(this.env, "sendMessage", { chat_id: userId, text: "🎬 Выбери диапазон Stars для анимации:", reply_markup: tierKeyboard("adm:animation", cfg.tiers) });
    } else if (action === "sounds") {
      await tg(this.env, "sendMessage", { chat_id: userId, text: "🔊 Выбери диапазон Stars для звука:", reply_markup: tierKeyboard("adm:sound", cfg.tiers) });
    } else if (action === "animation" || action === "sound") {
      const tier = Number(parts[2]);
      if (!cfg.tiers[tier]) return;
      await this.ctx.storage.put(`adminAction:${userId}`, { type: action, tier });
      const current = cfg.tiers[tier][action];
      await tg(this.env, "sendMessage", {
        chat_id: userId,
        text: `${action === "animation" ? "🎬" : "🔊"} ${cfg.tiers[tier].label}\n${current ? `Сейчас: ${current.name || current.mime}` : "Сейчас ничего не назначено."}\n\n${action === "animation" ? "Отправь GIF, WebM/MP4, картинку или обычный/видео-стикер." : "Отправь аудиофайл или voice."}`,
        reply_markup: { inline_keyboard: [[callbackButton("🗑 Удалить", `adm:clear:${action}:${tier}`)], [callbackButton("⬅️ Назад", action === "animation" ? "adm:animations" : "adm:sounds")]] }
      });
    } else if (action === "clear") {
      const kind = parts[2];
      const tier = Number(parts[3]);
      if (!["animation", "sound"].includes(kind) || !cfg.tiers[tier]) return;
      cfg.tiers[tier][kind] = null;
      await this.saveConfig(cfg);
      await this.ctx.storage.delete(`adminAction:${userId}`);
      await tg(this.env, "sendMessage", { chat_id: userId, text: `✅ Удалено для ${cfg.tiers[tier].label}.`, reply_markup: adminMenu() });
    } else if (action === "amounts") {
      await this.ctx.storage.put(`adminAction:${userId}`, { type: "amounts" });
      await tg(this.env, "sendMessage", { chat_id: userId, text: `⭐ Сейчас: ${cfg.amounts.join(" / ")}\n\nОтправь новые суммы одним сообщением, например:\n10, 25, 50, 100, 250, 500, 1000` });
    } else if (action === "test") {
      await tg(this.env, "sendMessage", { chat_id: userId, text: "🧪 Какой алерт проверить?", reply_markup: tierKeyboard("adm:testtier", cfg.tiers) });
    } else if (action === "testtier") {
      const tier = Number(parts[2]);
      if (!cfg.tiers[tier]) return;
      const amount = cfg.tiers[tier].min === 1 ? 10 : cfg.tiers[tier].min;
      await this.emitAlert({
        id: `test-${crypto.randomUUID()}`,
        ts: Date.now(),
        user: "@starchik_test",
        amount,
        comment: "Это тестовый алерт — Stars не списывались ✨",
        tier,
        test: true
      }, false);
      await tg(this.env, "sendMessage", { chat_id: userId, text: `✅ Тест ${cfg.tiers[tier].label} отправлен в OBS.` });
    } else if (action === "links") {
      await this.sendObsLinks(userId, cfg);
    } else if (action === "history") {
      const history = (await this.ctx.storage.get("history")) || [];
      const paid = history.filter(x => !x.test).slice(-10).reverse();
      const body = paid.length ? paid.map((x, i) => `${i + 1}. ${x.user} — ${x.amount} ⭐${x.comment ? `\n   “${x.comment}”` : ""}`).join("\n\n") : "Платежей пока нет.";
      await tg(this.env, "sendMessage", { chat_id: userId, text: `📋 Последние платежи\n\n${body}` });
    } else if (action === "rotate") {
      cfg.overlayKey = randomToken(24);
      await this.saveConfig(cfg);
      for (const ws of this.ctx.getWebSockets()) {
        try { ws.close(4001, "Overlay key rotated"); } catch {}
      }
      await tg(this.env, "sendMessage", { chat_id: userId, text: "🔐 OBS-ключ заменён. Старые ссылки больше не работают." });
      await this.sendObsLinks(userId, cfg);
    }
  }

  async beginDonation(userId, intended) {
    if (intended === "custom") {
      await this.ctx.storage.put(`pending:${userId}`, { stage: "custom" });
      await tg(this.env, "sendMessage", { chat_id: userId, text: `✏️ Напиши количество Stars числом (1–${MAX_CUSTOM_STARS}).`, reply_markup: { inline_keyboard: [[callbackButton("❌ Отмена", "cancel")]] } });
      return;
    }
    const amount = Number(intended);
    if (!Number.isInteger(amount) || amount < 1 || amount > MAX_CUSTOM_STARS) return;
    await this.ctx.storage.put(`pending:${userId}`, { stage: "comment", amount });
    await this.askComment(userId, amount);
  }

  async askComment(userId, amount) {
    await tg(this.env, "sendMessage", {
      chat_id: userId,
      text: `💬 ${amount} ⭐\nНапиши комментарий для стрима (до ${MAX_COMMENT} символов) или нажми «Без комментария».`,
      reply_markup: { inline_keyboard: [[callbackButton("Без комментария", "comment:skip")], [callbackButton("❌ Отмена", "cancel")]] }
    });
  }

  async createInvoice(user, amount, comment) {
    const payload = `st_${Date.now().toString(36)}_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
    const order = {
      payload,
      userId: user.id,
      user: formatUser(user),
      amount,
      comment: String(comment || "").slice(0, MAX_COMMENT),
      createdAt: Date.now(),
      status: "invoice_sent"
    };
    await this.ctx.storage.put(`order:${payload}`, order);

    await tg(this.env, "sendInvoice", {
      chat_id: user.id,
      title: `Поддержка ${this.env.BRAND_NAME}`.slice(0, 32),
      description: "Показ Stars-алерта и сообщения на стриме".slice(0, 255),
      payload,
      currency: "XTR",
      prices: [{ label: "Stars", amount }]
    });
  }

  async handlePreCheckout(query) {
    const payload = query.invoice_payload;
    const order = await this.ctx.storage.get(`order:${payload}`);
    const valid = !!order && order.status !== "paid" && query.currency === "XTR" && Number(query.total_amount) === Number(order.amount) && Number(query.from?.id) === Number(order.userId);
    await tg(this.env, "answerPreCheckoutQuery", valid
      ? { pre_checkout_query_id: query.id, ok: true }
      : { pre_checkout_query_id: query.id, ok: false, error_message: "Не удалось проверить заказ. Вернись в бот и создай новый платёж." }
    );
  }

  async handleSuccessfulPayment(message) {
    const payment = message.successful_payment;
    const payload = payment.invoice_payload;
    const order = await this.ctx.storage.get(`order:${payload}`);
    if (!order) return;
    if (payment.currency !== "XTR" || Number(payment.total_amount) !== Number(order.amount)) return;

    const chargeId = payment.telegram_payment_charge_id;
    const knownCharges = (await this.ctx.storage.get("charges")) || [];
    if (knownCharges.includes(chargeId)) return;
    knownCharges.push(chargeId);
    if (knownCharges.length > 300) knownCharges.splice(0, knownCharges.length - 300);
    await this.ctx.storage.put("charges", knownCharges);

    order.status = "paid";
    order.paidAt = Date.now();
    order.telegramPaymentChargeId = chargeId;
    await this.ctx.storage.put(`order:${payload}`, order);

    const cfg = await this.config();
    const tier = Math.max(0, cfg.tiers.findIndex(t => order.amount >= t.min && order.amount <= t.max));
    const alert = {
      id: chargeId,
      ts: Date.now(),
      user: order.user,
      amount: order.amount,
      comment: order.comment,
      tier,
      test: false
    };
    await this.emitAlert(alert, true);

    await tg(this.env, "sendMessage", {
      chat_id: message.chat.id,
      text: `💛 Спасибо! ${order.amount} ⭐ получены. Алерт отправлен на стрим.${order.comment ? `\n\nТвой комментарий: “${order.comment}”` : ""}`,
      reply_markup: mainMenu(cfg.amounts)
    });
  }

  async emitAlert(alert, persist) {
    if (persist) {
      const history = (await this.ctx.storage.get("history")) || [];
      history.push(alert);
      if (history.length > 100) history.splice(0, history.length - 100);
      await this.ctx.storage.put("history", history);
    }
    const message = JSON.stringify({ type: "alert", data: alert });
    for (const ws of this.ctx.getWebSockets()) {
      try { ws.send(message); } catch {}
    }
  }

  async sendObsLinks(userId, cfg) {
    const origin = cfg.origin;
    if (!origin) {
      await tg(this.env, "sendMessage", { chat_id: userId, text: "⚠️ Ссылка появится после первого Telegram webhook-запроса. Отправь /start и снова открой OBS-ссылки." });
      return;
    }
    const landscape = `${origin}/overlay/landscape?key=${cfg.overlayKey}`;
    const vertical = `${origin}/overlay/vertical?key=${cfg.overlayKey}`;
    await tg(this.env, "sendMessage", {
      chat_id: userId,
      text: `🔗 OBS Browser Source\n\n🖥 1920×1080:\n${landscape}\n\n📱 1080×1920:\n${vertical}\n\n⚠️ Не публикуй эти ссылки. Если утекут — нажми «Новый OBS-ключ».`,
      disable_web_page_preview: true
    });
  }
}
