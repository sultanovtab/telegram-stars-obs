import { DurableObject } from "cloudflare:workers";
import { overlayAssetUrl, goalAssetUrl } from "./overlay-route.js";
import {
  DEFAULT_TTS_PROFILES,
  normalizeConfigV4,
  enabledTtsProfiles,
  buildOrderPricing,
  buildStarInvoicePrices,
  findTierIndex,
  goalProgress,
  validatePreCheckout,
  validateSuccessfulPayment,
  buildPreCheckoutWebhookReply,
  nextAlertSequence,
  validateRefundedPayment
} from "./v4-logic.js";

const DEFAULT_AMOUNTS = [10, 25, 50, 100, 250, 500, 1000];
const MAX_COMMENT = 140;
const MAX_CUSTOM_STARS = 10000;
const INVOICE_RATE_LIMIT_MS = 1500;
const ORDER_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const ORDER_CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000;

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
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer"
    }
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

async function resolveSecretWithFallback(env, preferred, fallback = "APP_SECRET") {
  const primary = await resolveSecret(env, preferred);
  if (primary) return primary;
  return fallback ? resolveSecret(env, fallback) : "";
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
    "• Если выбрана озвучка, её стоимость добавляется к основной сумме до открытия Telegram invoice.",
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
      [callbackButton("🗣 Озвучка", "adm:tts"), callbackButton("⭐ Суммы", "adm:amounts")],
      [callbackButton("🎯 Цель сбора", "adm:goal"), callbackButton("💰 Баланс", "adm:balance")],
      [callbackButton("🧪 Тест алерта", "adm:test"), callbackButton("🔗 OBS-ссылки", "adm:links")],
      [callbackButton("📋 Последние платежи", "adm:history"), callbackButton("🔐 Новый OBS-ключ", "adm:rotate")]
    ]
  };
}

function ttsAdminKeyboard(profiles) {
  return {
    inline_keyboard: [
      ...profiles.map((p, i) => [callbackButton(`${p.enabled ? "✅" : "⛔"} ${p.label} • +${p.price} ⭐`, `adm:ttsprofile:${i}`)]),
      [callbackButton("⬅️ Админка", "adm:home")]
    ]
  };
}

function ttsProfileKeyboard(profile, index) {
  return {
    inline_keyboard: [
      [callbackButton(profile.enabled ? "⛔ Выключить" : "✅ Включить", `adm:ttstoggle:${index}`)],
      [callbackButton("💰 Изменить цену", `adm:ttsprice:${index}`), callbackButton("✏️ Переименовать", `adm:ttsname:${index}`)],
      [callbackButton("🧪 Тест озвучки", `adm:ttstest:${index}`)],
      [callbackButton("⬅️ Озвучка", "adm:tts")]
    ]
  };
}

function goalAdminKeyboard(goal) {
  return {
    inline_keyboard: [
      [callbackButton(goal.enabled ? "⛔ Скрыть виджет" : "✅ Показать виджет", "adm:goaltoggle")],
      [callbackButton("✏️ Название", "adm:goaltitle"), callbackButton("🎯 Сумма цели", "adm:goaltarget")],
      [callbackButton("♻️ Обновить баланс", "adm:goalrefresh"), callbackButton("🔗 OBS-ссылки цели", "adm:goallinks")],
      [callbackButton("⬅️ Админка", "adm:home")]
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
      const setupSecret = await resolveSecretWithFallback(env, "SETUP_SECRET");
      const claimSecret = await resolveSecretWithFallback(env, "CLAIM_SECRET");
      const webhookSecret = await resolveSecretWithFallback(env, "TELEGRAM_WEBHOOK_SECRET");
      const botToken = await resolveSecret(env, "BOT_TOKEN");
      if (!setupSecret || code !== setupSecret) return html("<h1>403</h1><p>Wrong setup code.</p>", 403);
      if (!botToken) return html("<h1>BOT_TOKEN is missing</h1>", 500);
      if (!claimSecret || !webhookSecret) return html("<h1>Missing security secrets</h1>", 500);

      const webhookUrl = `${origin}/telegram`;
      const webhookResult = await tg(env, "setWebhook", {
        url: webhookUrl,
        secret_token: webhookSecret,
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

      const dedicatedSecrets = Boolean(
        await resolveSecret(env, "SETUP_SECRET") &&
        await resolveSecret(env, "CLAIM_SECRET") &&
        await resolveSecret(env, "TELEGRAM_WEBHOOK_SECRET")
      );
      return html(`<!doctype html><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title>starchik setup</title>
      <style>body{font-family:system-ui;background:#0d1020;color:#fff;max-width:720px;margin:60px auto;padding:24px}code{background:#1b2140;padding:3px 7px;border-radius:7px}.ok{color:#82ffa1}.warn{color:#ffd479}</style>
      <h1 class="ok">✓ Webhook подключён</h1>
      <p>Telegram ответил: <code>${escapeHtml(String(webhookResult))}</code></p>
      ${dedicatedSecrets ? '<p class="ok">✓ Dedicated security secrets active.</p>' : '<p class="warn">⚠️ Пока используется совместимый APP_SECRET fallback. Добавь SETUP_SECRET, CLAIM_SECRET и TELEGRAM_WEBHOOK_SECRET в Cloudflare.</p>'}
      <p>Если владелец ещё не назначен, открой <b>@${escapeHtml(env.BOT_USERNAME)}</b> и отправь:</p>
      <p><code>/claim ${escapeHtml(claimSecret)}</code></p>
      <p>После успешного claim команда повторно владельца не сменит.</p>`);
    }

    if (url.pathname === "/telegram") {
      if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
      const secret = request.headers.get("X-Telegram-Bot-Api-Secret-Token") || "";
      const dedicatedWebhookSecret = await resolveSecret(env, "TELEGRAM_WEBHOOK_SECRET");
      const legacyWebhookSecret = await resolveSecret(env, "APP_SECRET");
      const webhookSecret = dedicatedWebhookSecret || legacyWebhookSecret;
      const acceptedSecrets = [webhookSecret, legacyWebhookSecret].filter(Boolean);
      if (!acceptedSecrets.includes(secret)) return new Response("Forbidden", { status: 403 });
      const headers = new Headers(request.headers);
      headers.set("x-worker-origin", origin);
      const forwarded = new Request("https://hub.internal/telegram", {
        method: "POST",
        headers,
        body: request.body
      });
      return hub.fetch(forwarded);
    }

    if (url.pathname === "/ws" || url.pathname.startsWith("/media/") || url.pathname === "/status" || url.pathname === "/goal-state") {
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

    if (url.pathname === "/goal/landscape" || url.pathname === "/goal/vertical") {
      const assetUrl = goalAssetUrl(request.url);
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
    this.ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair("ping", "pong")
    );
  }

  async config() {
    let cfg = await this.ctx.storage.get("config");
    if (!cfg) {
      cfg = {
        overlayKey: randomToken(24),
        amounts: DEFAULT_AMOUNTS,
        tiers: structuredClone(DEFAULT_TIERS),
        ttsProfiles: structuredClone(DEFAULT_TTS_PROFILES),
        goal: { enabled: false, title: "Цель сбора", target: 1000 },
        origin: null
      };
    }
    const normalized = normalizeConfigV4(cfg);
    if (JSON.stringify(normalized) !== JSON.stringify(cfg)) await this.ctx.storage.put("config", normalized);
    else if (!(await this.ctx.storage.get("config"))) await this.ctx.storage.put("config", normalized);
    return normalized;
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
    if (url.pathname === "/goal-state") return this.handleGoalState(request);
    return new Response("Not Found", { status: 404 });
  }

  async handleStatus(request) {
    const cfg = await this.config();
    const key = new URL(request.url).searchParams.get("key");
    if (key !== cfg.overlayKey) return json({ ok: false }, 403);
    return json({
      ok: true,
      brand: this.env.BRAND_NAME,
      tiers: cfg.tiers.map(t => ({ label: t.label, duration: t.duration, hasAnimation: !!t.animation, hasSound: !!t.sound })),
      ttsProfiles: cfg.ttsProfiles.map(p => ({ id: p.id, label: p.label, price: p.price, enabled: p.enabled })),
      goal: cfg.goal
    });
  }

  async getStarBalance(force = false) {
    const cached = await this.ctx.storage.get("starBalance");
    if (!force && cached && Date.now() - Number(cached.fetchedAt || 0) < 30000) return cached;
    try {
      const raw = await tg(this.env, "getMyStarBalance", {});
      const balance = {
        amount: Number(raw?.amount || 0),
        nanostarAmount: Number(raw?.nanostar_amount || 0),
        fetchedAt: Date.now()
      };
      await this.ctx.storage.put("starBalance", balance);
      return balance;
    } catch (error) {
      if (cached) return { ...cached, stale: true, error: String(error?.message || error) };
      throw error;
    }
  }

  async getGoalState(force = false) {
    const cfg = await this.config();
    const balance = await this.getStarBalance(force);
    const progress = goalProgress(balance.amount, cfg.goal.target);
    return {
      enabled: !!cfg.goal.enabled,
      title: cfg.goal.title,
      current: progress.current,
      target: progress.target,
      percent: progress.percent,
      nanostarAmount: balance.nanostarAmount || 0,
      updatedAt: balance.fetchedAt || Date.now(),
      stale: !!balance.stale
    };
  }

  async handleGoalState(request) {
    const url = new URL(request.url);
    const cfg = await this.config();
    if (url.searchParams.get("key") !== cfg.overlayKey) return json({ ok: false }, 403);
    try {
      return json({ ok: true, goal: await this.getGoalState(false) });
    } catch (error) {
      return json({ ok: false, error: String(error?.message || error) }, 502);
    }
  }

  async broadcastGoal(force = false) {
    let goal;
    try { goal = await this.getGoalState(force); } catch { return; }
    const message = JSON.stringify({ type: "goal", data: goal });
    for (const ws of this.ctx.getWebSockets()) {
      try {
        const attachment = ws.deserializeAttachment?.();
        if (attachment?.mode !== "goal") continue;
        ws.send(message);
      } catch {}
    }
  }

  async handleWebSocket(request) {
    const url = new URL(request.url);
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return new Response("Expected websocket", { status: 426 });
    const cfg = await this.config();
    if (url.searchParams.get("key") !== cfg.overlayKey) return new Response("Forbidden", { status: 403 });

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    const layout = url.searchParams.get("layout") === "vertical" ? "vertical" : "landscape";
    const mode = url.searchParams.get("mode") === "goal" ? "goal" : "alerts";
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ layout, mode });

    const history = (await this.ctx.storage.get("history")) || [];
    const helloData = {
      brand: this.env.BRAND_NAME,
      layout,
      mode,
      recent: mode === "alerts" ? history.slice(-100) : [],
      tiers: cfg.tiers.map((t, i) => ({ index: i, label: t.label, duration: t.duration, hasAnimation: !!t.animation, hasSound: !!t.sound }))
    };
    if (mode === "goal") {
      try { helloData.goal = await this.getGoalState(false); } catch {}
    }
    server.send(JSON.stringify({ type: "hello", data: helloData }));

    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(ws, message) {
    console.warn("starchik rejected unexpected WebSocket client message", String(message).slice(0, 120));
    try { ws.close(1008, "Client messages are not accepted"); } catch {}
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
        return json(await this.handlePreCheckout(update.pre_checkout_query));
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
      return json({ ok: false, error: "temporary_processing_failure" }, 503);
    }
  }

  async handleMessage(message) {
    if (message.chat?.type !== "private") return;
    if (message.refunded_payment) {
      await this.handleRefundedPayment(message);
      return;
    }

    const user = message.from;
    if (!user) return;
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
      const claimSecret = await resolveSecretWithFallback(this.env, "CLAIM_SECRET");
      if (!claimSecret || code !== claimSecret) {
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

      if (adminAction.type === "ttsprice") {
        const value = Math.trunc(Number(text.replace(/[^0-9]/g, "")));
        if (!Number.isFinite(value) || value < 0 || value > 5000) {
          await tg(this.env, "sendMessage", { chat_id: userId, text: "Введи цену озвучки от 0 до 5000 ⭐." });
          return;
        }
        const cfg = await this.config();
        if (!cfg.ttsProfiles[adminAction.profile]) return;
        cfg.ttsProfiles[adminAction.profile].price = value;
        await this.saveConfig(cfg);
        await this.ctx.storage.delete(`adminAction:${userId}`);
        await tg(this.env, "sendMessage", { chat_id: userId, text: `✅ Цена сохранена: +${value} ⭐`, reply_markup: ttsProfileKeyboard(cfg.ttsProfiles[adminAction.profile], adminAction.profile) });
        return;
      }

      if (adminAction.type === "ttsname") {
        const value = text.trim().slice(0, 32);
        if (value.length < 2) {
          await tg(this.env, "sendMessage", { chat_id: userId, text: "Название должно быть хотя бы из 2 символов." });
          return;
        }
        const cfg = await this.config();
        if (!cfg.ttsProfiles[adminAction.profile]) return;
        cfg.ttsProfiles[adminAction.profile].label = value;
        await this.saveConfig(cfg);
        await this.ctx.storage.delete(`adminAction:${userId}`);
        await tg(this.env, "sendMessage", { chat_id: userId, text: `✅ Название сохранено: ${value}`, reply_markup: ttsProfileKeyboard(cfg.ttsProfiles[adminAction.profile], adminAction.profile) });
        return;
      }

      if (adminAction.type === "goaltitle") {
        const value = text.trim().slice(0, 80);
        if (value.length < 2) {
          await tg(this.env, "sendMessage", { chat_id: userId, text: "Название цели должно быть хотя бы из 2 символов." });
          return;
        }
        const cfg = await this.config();
        cfg.goal.title = value;
        await this.saveConfig(cfg);
        await this.ctx.storage.delete(`adminAction:${userId}`);
        await this.broadcastGoal(false);
        await tg(this.env, "sendMessage", { chat_id: userId, text: `✅ Новая цель: ${value}`, reply_markup: goalAdminKeyboard(cfg.goal) });
        return;
      }

      if (adminAction.type === "goaltarget") {
        const value = Math.trunc(Number(text.replace(/[^0-9]/g, "")));
        if (!Number.isFinite(value) || value < 1 || value > 1000000000) {
          await tg(this.env, "sendMessage", { chat_id: userId, text: "Введи цель целым числом от 1 до 1 000 000 000 ⭐." });
          return;
        }
        const cfg = await this.config();
        cfg.goal.target = value;
        await this.saveConfig(cfg);
        await this.ctx.storage.delete(`adminAction:${userId}`);
        await this.broadcastGoal(false);
        await tg(this.env, "sendMessage", { chat_id: userId, text: `✅ Сумма цели: ${value} ⭐`, reply_markup: goalAdminKeyboard(cfg.goal) });
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
      await this.offerTtsOrInvoice(user, pending.amount, comment);
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
        await this.createInvoice(user, pending.amount, "", null);
        await this.ctx.storage.delete(`pending:${userId}`);
      }
      return;
    }

    if (data === "tts:none" || data.startsWith("tts:")) {
      const pending = await this.ctx.storage.get(`pending:${userId}`);
      if (pending?.stage !== "tts") return;
      if (data === "tts:none") {
        await this.createInvoice(user, pending.baseAmount, pending.comment, null);
      } else {
        const id = data.slice(4);
        const cfg = await this.config();
        const profile = cfg.ttsProfiles.find(p => p.id === id && p.enabled);
        if (!profile) {
          await tg(this.env, "sendMessage", { chat_id: userId, text: "⚠️ Эта озвучка сейчас недоступна. Выбери другой вариант." });
          await this.offerTtsOrInvoice(user, pending.baseAmount, pending.comment);
          return;
        }
        await this.createInvoice(user, pending.baseAmount, pending.comment, profile);
      }
      await this.ctx.storage.delete(`pending:${userId}`);
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
        text: `${action === "animation" ? "🎬" : "🔊"} ${cfg.tiers[tier].label}
${current ? `Сейчас: ${current.name || current.mime}` : "Сейчас ничего не назначено."}

${action === "animation" ? "Отправь GIF, WebM/MP4, картинку или обычный/видео-стикер." : "Отправь аудиофайл или voice."}`,
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
    } else if (action === "tts") {
      const lines = cfg.ttsProfiles.map((p, i) => `${i + 1}. ${p.enabled ? "✅" : "⛔"} ${p.label} — +${p.price} ⭐`).join("\n");
      await tg(this.env, "sendMessage", { chat_id: userId, text: `🗣 Озвучка

${lines}

Зрители видят только включённые варианты. Стандартная работает через системный голос OBS; остальные слоты можно держать выключенными до подключения отдельных голосов.`, reply_markup: ttsAdminKeyboard(cfg.ttsProfiles) });
    } else if (action === "ttsprofile") {
      const index = Number(parts[2]);
      const profile = cfg.ttsProfiles[index];
      if (!profile) return;
      await tg(this.env, "sendMessage", { chat_id: userId, text: `🗣 ${profile.label}
Статус: ${profile.enabled ? "включена" : "выключена"}
Доплата: +${profile.price} ⭐
Язык: ${profile.lang || "ru-RU"}`, reply_markup: ttsProfileKeyboard(profile, index) });
    } else if (action === "ttstoggle") {
      const index = Number(parts[2]);
      if (!cfg.ttsProfiles[index]) return;
      cfg.ttsProfiles[index].enabled = !cfg.ttsProfiles[index].enabled;
      await this.saveConfig(cfg);
      await tg(this.env, "sendMessage", { chat_id: userId, text: `${cfg.ttsProfiles[index].enabled ? "✅ Включено" : "⛔ Выключено"}: ${cfg.ttsProfiles[index].label}`, reply_markup: ttsProfileKeyboard(cfg.ttsProfiles[index], index) });
    } else if (action === "ttsprice") {
      const index = Number(parts[2]);
      if (!cfg.ttsProfiles[index]) return;
      await this.ctx.storage.put(`adminAction:${userId}`, { type: "ttsprice", profile: index });
      await tg(this.env, "sendMessage", { chat_id: userId, text: `💰 Сейчас ${cfg.ttsProfiles[index].label}: +${cfg.ttsProfiles[index].price} ⭐
Отправь новую доплату числом.` });
    } else if (action === "ttsname") {
      const index = Number(parts[2]);
      if (!cfg.ttsProfiles[index]) return;
      await this.ctx.storage.put(`adminAction:${userId}`, { type: "ttsname", profile: index });
      await tg(this.env, "sendMessage", { chat_id: userId, text: `✏️ Отправь новое название для «${cfg.ttsProfiles[index].label}».` });
    } else if (action === "ttstest") {
      const index = Number(parts[2]);
      const profile = cfg.ttsProfiles[index];
      if (!profile) return;
      const pricing = buildOrderPricing(100, { ...profile, enabled: true });
      await this.emitAlert({
        id: `tts-test-${crypto.randomUUID()}`,
        ts: Date.now(),
        user: "@starchik_test",
        amount: pricing.totalAmount,
        baseAmount: pricing.baseAmount,
        totalAmount: pricing.totalAmount,
        comment: `Проверка озвучки «${profile.label}». Если ты это слышишь — всё работает.`,
        tts: pricing.tts,
        tier: findTierIndex(pricing.baseAmount, cfg.tiers),
        test: true
      }, false);
      await tg(this.env, "sendMessage", { chat_id: userId, text: `✅ Тест озвучки «${profile.label}» отправлен в OBS.` });
    } else if (action === "amounts") {
      await this.ctx.storage.put(`adminAction:${userId}`, { type: "amounts" });
      await tg(this.env, "sendMessage", { chat_id: userId, text: `⭐ Сейчас: ${cfg.amounts.join(" / ")}

Отправь новые суммы одним сообщением, например:
10, 25, 50, 100, 250, 500, 1000` });
    } else if (action === "goal") {
      let state;
      try { state = await this.getGoalState(false); } catch { state = { current: 0, percent: 0, target: cfg.goal.target }; }
      await tg(this.env, "sendMessage", { chat_id: userId, text: `🎯 Цель сбора

${cfg.goal.enabled ? "✅ Виджет включён" : "⛔ Виджет скрыт"}
Название: ${cfg.goal.title}
Баланс: ${state.current} ⭐
Цель: ${cfg.goal.target} ⭐
Прогресс: ${state.percent}%`, reply_markup: goalAdminKeyboard(cfg.goal) });
    } else if (action === "goaltoggle") {
      cfg.goal.enabled = !cfg.goal.enabled;
      await this.saveConfig(cfg);
      await this.broadcastGoal(false);
      await tg(this.env, "sendMessage", { chat_id: userId, text: cfg.goal.enabled ? "✅ Виджет цели включён." : "⛔ Виджет цели скрыт.", reply_markup: goalAdminKeyboard(cfg.goal) });
    } else if (action === "goaltitle") {
      await this.ctx.storage.put(`adminAction:${userId}`, { type: "goaltitle" });
      await tg(this.env, "sendMessage", { chat_id: userId, text: `✏️ Сейчас: ${cfg.goal.title}
Отправь новое название цели, например: «На новое кресло».` });
    } else if (action === "goaltarget") {
      await this.ctx.storage.put(`adminAction:${userId}`, { type: "goaltarget" });
      await tg(this.env, "sendMessage", { chat_id: userId, text: `🎯 Сейчас цель: ${cfg.goal.target} ⭐
Отправь новое количество Stars числом.` });
    } else if (action === "goalrefresh") {
      try {
        const state = await this.getGoalState(true);
        await this.broadcastGoal(false);
        await tg(this.env, "sendMessage", { chat_id: userId, text: `♻️ Баланс обновлён: ${state.current} ⭐ • ${state.percent}% от ${state.target} ⭐`, reply_markup: goalAdminKeyboard(cfg.goal) });
      } catch (error) {
        await tg(this.env, "sendMessage", { chat_id: userId, text: `⚠️ Не удалось получить баланс: ${String(error?.message || error)}` });
      }
    } else if (action === "goallinks") {
      await this.sendGoalLinks(userId, cfg);
    } else if (action === "balance") {
      try {
        const balance = await this.getStarBalance(true);
        const progress = goalProgress(balance.amount, cfg.goal.target);
        await tg(this.env, "sendMessage", { chat_id: userId, text: `💰 Баланс @${this.env.BOT_USERNAME}

Доступно: ${balance.amount} ⭐
Текущая цель: ${cfg.goal.title}
${progress.current} / ${progress.target} ⭐ • ${progress.percent}%` });
        await this.broadcastGoal(false);
      } catch (error) {
        await tg(this.env, "sendMessage", { chat_id: userId, text: `⚠️ Telegram не отдал баланс: ${String(error?.message || error)}` });
      }
    } else if (action === "test") {
      await tg(this.env, "sendMessage", { chat_id: userId, text: "🧪 Какой алерт проверить?", reply_markup: tierKeyboard("adm:testtier", cfg.tiers) });
    } else if (action === "testtier") {
      const tier = Number(parts[2]);
      if (!cfg.tiers[tier]) return;
      const baseAmount = cfg.tiers[tier].min === 1 ? 10 : cfg.tiers[tier].min;
      await this.emitAlert({
        id: `test-${crypto.randomUUID()}`,
        ts: Date.now(),
        user: "@starchik_test",
        amount: baseAmount,
        baseAmount,
        totalAmount: baseAmount,
        comment: "Это тестовый алерт. Теперь длинный текст остаётся на экране дольше, чтобы его можно было прочитать ✨",
        tier,
        test: true
      }, false);
      await tg(this.env, "sendMessage", { chat_id: userId, text: `✅ Тест ${cfg.tiers[tier].label} отправлен в OBS.` });
    } else if (action === "links") {
      await this.sendObsLinks(userId, cfg);
    } else if (action === "refund") {
      const payload = parts.slice(2).join(":");
      const order = await this.ctx.storage.get(`order:${payload}`);
      if (!order) {
        await tg(this.env, "sendMessage", { chat_id: userId, text: "⚠️ Платёж не найден." });
      } else if (order.status === "refunded") {
        await tg(this.env, "sendMessage", { chat_id: userId, text: "↩️ Этот платёж уже возвращён." });
      } else if (order.status !== "paid" || !order.telegramPaymentChargeId) {
        await tg(this.env, "sendMessage", { chat_id: userId, text: "⚠️ Этот платёж сейчас нельзя вернуть." });
      } else {
        await tg(this.env, "sendMessage", {
          chat_id: userId,
          text: `⚠️ Подтвердить полный возврат ${order.totalAmount ?? order.amount} ⭐ пользователю ${order.user}?`,
          reply_markup: { inline_keyboard: [
            [callbackButton("↩️ Да, вернуть Stars", `adm:refundconfirm:${payload}`)],
            [callbackButton("❌ Отмена", "adm:history")]
          ] }
        });
      }
    } else if (action === "refundconfirm") {
      const payload = parts.slice(2).join(":");
      try {
        const result = await this.refundPaymentByPayload(payload);
        await tg(this.env, "sendMessage", { chat_id: userId, text: result.message, reply_markup: adminMenu() });
      } catch (error) {
        console.error("starchik refund failed", error);
        await tg(this.env, "sendMessage", {
          chat_id: userId,
          text: `⚠️ Telegram не подтвердил возврат. Проверь историю перед повторной попыткой.
${String(error?.message || error)}`,
          reply_markup: adminMenu()
        });
      }
    } else if (action === "history") {
      const history = (await this.ctx.storage.get("history")) || [];
      const paid = history.filter(x => !x.test).slice(-10).reverse();
      const lines = [];
      const refundButtons = [];
      for (let i = 0; i < paid.length; i++) {
        const item = paid[i];
        const order = item.payload ? await this.ctx.storage.get(`order:${item.payload}`) : null;
        const status = order?.status === "refunded" ? " • ↩️ возврат" : "";
        lines.push(`${i + 1}. ${item.user} — ${item.totalAmount ?? item.amount} ⭐${item.tts ? ` • 🔊 ${item.tts.label}` : ""}${status}${item.comment ? `
   “${item.comment}”` : ""}`);
        if (i < 5 && item.payload && order?.status === "paid" && order.telegramPaymentChargeId) {
          refundButtons.push([callbackButton(`↩️ Возврат #${i + 1} • ${item.totalAmount ?? item.amount} ⭐`, `adm:refund:${item.payload}`)]);
        }
      }
      const body = lines.length ? lines.join("\n\n") : "Платежей пока нет.";
      const reply_markup = refundButtons.length
        ? { inline_keyboard: [...refundButtons, [callbackButton("⬅️ Админка", "adm:home")]] }
        : adminMenu();
      await tg(this.env, "sendMessage", { chat_id: userId, text: `📋 Последние платежи

${body}`, reply_markup });
    } else if (action === "rotate") {
      cfg.overlayKey = randomToken(24);
      await this.saveConfig(cfg);
      for (const ws of this.ctx.getWebSockets()) {
        try { ws.close(4001, "Overlay key rotated"); } catch {}
      }
      await tg(this.env, "sendMessage", { chat_id: userId, text: "🔐 OBS-ключ заменён. Старые ссылки больше не работают." });
      await this.sendObsLinks(userId, cfg);
      await this.sendGoalLinks(userId, cfg);
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

  async offerTtsOrInvoice(user, baseAmount, comment) {
    const cfg = await this.config();
    const profiles = enabledTtsProfiles(cfg.ttsProfiles);
    const cleanComment = String(comment || "").slice(0, MAX_COMMENT);
    if (!cleanComment || !profiles.length) {
      await this.createInvoice(user, baseAmount, cleanComment, null);
      await this.ctx.storage.delete(`pending:${user.id}`);
      return;
    }
    await this.ctx.storage.put(`pending:${user.id}`, { stage: "tts", baseAmount, comment: cleanComment });
    const rows = profiles.map(p => [callbackButton(`🔊 ${p.label} +${p.price} ⭐`, `tts:${p.id}`)]);
    rows.push([callbackButton("Без озвучки", "tts:none")], [callbackButton("❌ Отмена", "cancel")]);
    await tg(this.env, "sendMessage", {
      chat_id: user.id,
      text: `🗣 Озвучить сообщение на стриме?
Основная поддержка: ${baseAmount} ⭐
Озвучка добавляется к сумме до оплаты.`,
      reply_markup: { inline_keyboard: rows }
    });
  }

  async cleanupStaleOrders(now = Date.now()) {
    const lastCleanup = Number(await this.ctx.storage.get("lastOrderCleanup") || 0);
    if (now - lastCleanup < ORDER_CLEANUP_INTERVAL_MS) return;

    const orders = await this.ctx.storage.list({ prefix: "order:", limit: 200 });
    const expired = [];
    for (const [key, order] of orders) {
      if (order?.status === "invoice_sent" && now - Number(order.createdAt || 0) > ORDER_RETENTION_MS) {
        expired.push(key);
      }
    }
    if (expired.length) await this.ctx.storage.delete(expired);
    await this.ctx.storage.put("lastOrderCleanup", now);
  }

  async createInvoice(user, baseAmount, comment, ttsProfile = null) {
    const now = Date.now();
    const invoiceRateKey = `invoiceRate:${user.id}`;
    const lastInvoiceAt = Number(await this.ctx.storage.get(invoiceRateKey) || 0);
    if (now - lastInvoiceAt < INVOICE_RATE_LIMIT_MS) {
      await tg(this.env, "sendMessage", {
        chat_id: user.id,
        text: "⏳ Слишком быстро. Подожди пару секунд и создай платёж ещё раз."
      });
      return;
    }
    await this.cleanupStaleOrders(now);

    const pricing = buildOrderPricing(baseAmount, ttsProfile);
    const payload = `st_${now.toString(36)}_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
    const order = {
      payload,
      userId: user.id,
      user: formatUser(user),
      amount: pricing.totalAmount,
      baseAmount: pricing.baseAmount,
      totalAmount: pricing.totalAmount,
      ttsFee: pricing.ttsFee,
      tts: pricing.tts,
      comment: String(comment || "").slice(0, MAX_COMMENT),
      createdAt: now,
      status: "invoice_sent"
    };
    await this.ctx.storage.put(`order:${payload}`, order);

    const prices = buildStarInvoicePrices(pricing);
    await tg(this.env, "sendInvoice", {
      chat_id: user.id,
      title: `Поддержка ${this.env.BRAND_NAME}`.slice(0, 32),
      description: pricing.tts ? `Алерт + озвучка «${pricing.tts.label}»` : "Показ Stars-алерта и сообщения на стриме",
      payload,
      currency: "XTR",
      prices
    });
    await this.ctx.storage.put(invoiceRateKey, now);
  }

  async handlePreCheckout(query) {
    const order = await this.ctx.storage.get(`order:${query.invoice_payload}`);
    const validation = validatePreCheckout(order, query);
    return buildPreCheckoutWebhookReply(query.id, validation);
  }

  async sendPaymentReceipt(record, message, cfg) {
    if (record.receiptSent || record.status === "refunded") return record;
    const order = record.order || {};
    const detail = order.tts ? `\n🔊 ${order.tts.label}: +${order.tts.price} ⭐` : "";
    await tg(this.env, "sendMessage", {
      chat_id: message.chat.id,
      text: `💛 Спасибо! ${record.totalAmount} ⭐ получены.${detail}\nАлерт отправлен на стрим.${order.comment ? `\n\nТвой комментарий: “${order.comment}”` : ""}`,
      reply_markup: mainMenu(cfg.amounts)
    });
    const updated = { ...record, receiptSent: true, receiptSentAt: Date.now() };
    await this.ctx.storage.put(`payment:${record.chargeId}`, updated);
    return updated;
  }

  async handleSuccessfulPayment(message) {
    const payment = message.successful_payment;
    const payload = payment?.invoice_payload;
    const orderKey = `order:${payload}`;
    const order = await this.ctx.storage.get(orderKey);
    const validation = validateSuccessfulPayment(order, message);
    if (!validation.ok) {
      console.error("Rejected successful_payment", {
        reason: validation.reason,
        payload,
        userId: message.from?.id,
        currency: payment?.currency,
        amount: payment?.total_amount
      });
      return;
    }

    const { chargeId, totalAmount, baseAmount } = validation;
    const paymentKey = `payment:${chargeId}`;
    const cfg = await this.config();

    let record = await this.ctx.storage.get(paymentKey);
    if (!record) {
      record = await this.ctx.storage.transaction(async txn => {
        const existing = await txn.get(paymentKey);
        if (existing) return existing;

        const seq = nextAlertSequence(await txn.get("alertSeq"));
        const history = (await txn.get("history")) || [];
        const paidAt = Date.now();
        const paidOrder = {
          ...order,
          status: "paid",
          paidAt,
          telegramPaymentChargeId: chargeId
        };
        const alert = {
          id: chargeId,
          seq,
          ts: paidAt,
          payload,
          user: order.user,
          amount: totalAmount,
          baseAmount,
          totalAmount,
          comment: order.comment,
          tts: order.tts || null,
          tier: findTierIndex(baseAmount, cfg.tiers),
          test: false
        };
        history.push(alert);
        if (history.length > 100) history.splice(0, history.length - 100);

        const paymentRecord = {
          chargeId,
          payload,
          userId: order.userId,
          totalAmount,
          baseAmount,
          status: "committed",
          delivery: "pending",
          receiptSent: false,
          createdAt: paidAt,
          order: paidOrder,
          alert
        };
        await txn.put({
          [paymentKey]: paymentRecord,
          [orderKey]: paidOrder,
          history,
          alertSeq: seq
        });
        return paymentRecord;
      });
    }

    if (record.payload !== payload || Number(record.userId) !== Number(order.userId)) {
      throw new Error("Payment charge ID collision detected");
    }
    if (record.status === "refunded") return;

    if (record.delivery !== "sent") {
      await this.emitAlert(record.alert, false);
      record = { ...record, delivery: "sent", deliveredAt: Date.now() };
      await this.ctx.storage.put(paymentKey, record);
      await this.broadcastGoal(true);
    }

    await this.sendPaymentReceipt(record, message, cfg);
  }

  async handleRefundedPayment(message) {
    const refund = message.refunded_payment;
    if (!refund) return;
    const chargeId = String(refund.telegram_payment_charge_id || "").trim();
    const payload = String(refund.invoice_payload || "");
    if (!chargeId || !payload || refund.currency !== "XTR") return;

    const paymentKey = `payment:${chargeId}`;
    const orderKey = `order:${payload}`;
    const [record, order] = await Promise.all([
      this.ctx.storage.get(paymentKey),
      this.ctx.storage.get(orderKey)
    ]);
    if (!record && !order) return;
    const validation = validateRefundedPayment(order, record, refund);
    if (!validation.ok) {
      console.error("Rejected refunded_payment", { reason: validation.reason, payload, chargeId });
      return;
    }

    const refundedAt = Date.now();
    const updatedOrder = order ? {
      ...order,
      status: "refunded",
      refundedAt,
      telegramPaymentChargeId: chargeId
    } : null;
    const updatedRecord = record ? {
      ...record,
      status: "refunded",
      refundedAt
    } : null;
    const entries = {};
    if (updatedOrder) entries[orderKey] = updatedOrder;
    if (updatedRecord) entries[paymentKey] = updatedRecord;
    if (Object.keys(entries).length) await this.ctx.storage.put(entries);
    await this.broadcastGoal(true);
  }

  async refundPaymentByPayload(payload) {
    const orderKey = `order:${payload}`;
    const order = await this.ctx.storage.get(orderKey);
    if (!order) return { ok: false, message: "Платёж не найден." };
    if (order.status === "refunded") return { ok: false, message: "Этот платёж уже возвращён." };
    if (order.status !== "paid" || !order.telegramPaymentChargeId) {
      return { ok: false, message: "Этот платёж нельзя вернуть из текущего состояния." };
    }

    await tg(this.env, "refundStarPayment", {
      user_id: order.userId,
      telegram_payment_charge_id: order.telegramPaymentChargeId
    });

    const refundedAt = Date.now();
    const paymentKey = `payment:${order.telegramPaymentChargeId}`;
    const record = await this.ctx.storage.get(paymentKey);
    const updatedOrder = { ...order, status: "refunded", refundedAt };
    const entries = { [orderKey]: updatedOrder };
    if (record) entries[paymentKey] = { ...record, status: "refunded", refundedAt };
    await this.ctx.storage.put(entries);
    await this.broadcastGoal(true);
    return { ok: true, message: `↩️ Возврат ${order.totalAmount ?? order.amount} ⭐ отправлен через Telegram.` };
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
      try {
        const attachment = ws.deserializeAttachment?.();
        if (attachment?.mode !== "alerts") continue;
        ws.send(message);
      } catch {}
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
      text: `🔗 OBS Browser Source — алерты

🖥 1920×1080:
${landscape}

📱 1080×1920:
${vertical}

⚠️ Не публикуй эти ссылки. Если утекут — нажми «Новый OBS-ключ».`,
      disable_web_page_preview: true
    });
  }

  async sendGoalLinks(userId, cfg) {
    const origin = cfg.origin;
    if (!origin) {
      await tg(this.env, "sendMessage", { chat_id: userId, text: "⚠️ Ссылка цели появится после первого Telegram webhook-запроса." });
      return;
    }
    const landscape = `${origin}/goal/landscape?key=${cfg.overlayKey}`;
    const vertical = `${origin}/goal/vertical?key=${cfg.overlayKey}`;
    await tg(this.env, "sendMessage", {
      chat_id: userId,
      text: `🎯 OBS Browser Source — цель сбора

🖥 1920×1080:
${landscape}

📱 1080×1920:
${vertical}

Виджет сам синхронизирует текущий баланс Telegram Stars.`,
      disable_web_page_preview: true
    });
  }

}
