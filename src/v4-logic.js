export const DEFAULT_TTS_PROFILES = [
  { id: 'standard', label: 'Стандартная', price: 10, enabled: true, lang: 'ru-RU', rate: 1, pitch: 1, voiceName: '' },
  { id: 'premium', label: 'Премиум', price: 25, enabled: false, lang: 'ru-RU', rate: 0.96, pitch: 0.92, voiceName: '' },
  { id: 'premium_plus', label: 'Премиум+', price: 40, enabled: false, lang: 'ru-RU', rate: 0.94, pitch: 1.08, voiceName: '' },
  { id: 'ultra', label: 'Ультра', price: 75, enabled: false, lang: 'ru-RU', rate: 0.9, pitch: 0.86, voiceName: '' },
  { id: 'ultra_plus', label: 'Ультра+', price: 100, enabled: false, lang: 'ru-RU', rate: 0.88, pitch: 1.14, voiceName: '' }
];

export const DEFAULT_GOAL = {
  enabled: false,
  title: 'Цель сбора',
  target: 1000
};

function clone(value) {
  return value == null ? value : structuredClone(value);
}

export function normalizeConfigV4(cfg = {}) {
  const next = { ...cfg };
  const incomingProfiles = Array.isArray(cfg.ttsProfiles) ? cfg.ttsProfiles : [];
  next.ttsProfiles = DEFAULT_TTS_PROFILES.map((fallback, index) => ({
    ...fallback,
    ...(incomingProfiles[index] || {})
  }));
  next.goal = { ...DEFAULT_GOAL, ...(cfg.goal || {}) };
  next.goal.enabled = !!next.goal.enabled;
  next.goal.title = String(next.goal.title || DEFAULT_GOAL.title).slice(0, 80);
  const target = Math.trunc(Number(next.goal.target));
  next.goal.target = Number.isFinite(target) && target > 0 ? target : DEFAULT_GOAL.target;
  if (Array.isArray(cfg.tiers)) next.tiers = clone(cfg.tiers);
  if (Array.isArray(cfg.amounts)) next.amounts = clone(cfg.amounts);
  return next;
}

export function enabledTtsProfiles(profiles = []) {
  return profiles.filter(p => p && p.enabled && Number(p.price) >= 0);
}

export function getOrderMediaFee(order) {
  if (!order || order.mediaFee === undefined) return 0;
  return Math.max(0, Math.trunc(Number(order.mediaFee) || 0));
}

export function getOrderDisplayName(order) {
  if (!order) return 'Unknown';
  if (order.displayName !== undefined && order.displayName !== null && String(order.displayName).trim() !== '') {
    return String(order.displayName).trim();
  }
  return order.user || 'Unknown';
}

export function validateViewerMedia(mediaObj, typeHint = '') {
  if (!mediaObj) return { ok: false, reason: 'media_missing' };

  if (mediaObj.is_animated) {
    return { ok: false, reason: 'unsupported_animated_sticker' };
  }

  const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
  if (mediaObj.file_size && Number(mediaObj.file_size) > MAX_FILE_SIZE) {
    return { ok: false, reason: 'file_too_large' };
  }

  return { ok: true, reason: 'ok' };
}

export function calculatePlayAt(paidAt, alertDelayMs = 10000) {
  const t = Math.trunc(Number(paidAt) || Date.now());
  const delay = Math.max(0, Math.trunc(Number(alertDelayMs) || 10000));
  return t + delay;
}

export function buildOrderPricingV5({
  baseAmount,
  ttsProfile = null,
  mediaAttachment = null,
  displayName = '',
  isAnonymous = false,
  user = null
}) {
  const base = Math.max(1, Math.trunc(Number(baseAmount) || 0));

  let ttsFee = 0;
  let tts = null;
  if (ttsProfile?.enabled) {
    ttsFee = Math.max(0, Math.trunc(Number(ttsProfile.price) || 0));
    tts = {
      id: String(ttsProfile.id || 'standard'),
      label: String(ttsProfile.label || 'Озвучка'),
      price: ttsFee,
      lang: String(ttsProfile.lang || 'ru-RU'),
      rate: Number(ttsProfile.rate) || 1,
      pitch: Number(ttsProfile.pitch) || 1,
      voiceName: String(ttsProfile.voiceName || '')
    };
  }

  let mediaFee = 0;
  let media = null;
  if (mediaAttachment) {
    mediaFee = Math.max(0, Math.trunc(Number(mediaAttachment.price) || 0));
    media = {
      fileId: mediaAttachment.fileId,
      fileUniqueId: mediaAttachment.fileUniqueId || null,
      mime: mediaAttachment.mime || 'application/octet-stream',
      name: mediaAttachment.name || 'media',
      type: mediaAttachment.type || 'photo'
    };
  }

  let finalDisplayName = 'Unknown';
  if (isAnonymous) {
    finalDisplayName = 'Unknown';
  } else if (String(displayName || '').trim()) {
    finalDisplayName = String(displayName).trim().slice(0, 40);
  } else if (user) {
    finalDisplayName = 'Unknown'; // Privacy invariant: new flow uses Unknown if not explicitly provided
  }

  const totalAmount = base + ttsFee + mediaFee;

  return {
    baseAmount: base,
    ttsFee,
    mediaFee,
    totalAmount,
    tts,
    media,
    displayName: finalDisplayName
  };
}

export function buildOrderPricing(baseAmount, profile = null) {
  const pricing = buildOrderPricingV5({ baseAmount, ttsProfile: profile });
  return {
    baseAmount: pricing.baseAmount,
    ttsFee: pricing.ttsFee,
    totalAmount: pricing.totalAmount,
    tts: pricing.tts
  };
}

export function findTierIndex(amount, tiers = []) {
  const value = Number(amount) || 0;
  const index = tiers.findIndex(t => value >= Number(t.min) && value <= Number(t.max));
  return index >= 0 ? index : 0;
}

export function goalProgress(currentBalance, targetAmount) {
  const current = Math.max(0, Number(currentBalance) || 0);
  const target = Math.max(1, Number(targetAmount) || 1);
  const percent = Math.min(100, Math.round((current / target) * 1000) / 10);
  return { current, target, percent };
}

export function buildStarInvoicePrices(pricing) {
  const total = Math.max(1, Math.trunc(Number(pricing?.totalAmount) || 0));
  return [{ label: pricing?.tts ? 'Поддержка + озвучка' : 'Поддержка', amount: total }];
}

export function validatePreCheckout(order, query = {}) {
  if (!order) return { ok: false, reason: 'order_not_found' };
  if (order.status !== 'invoice_sent') return { ok: false, reason: 'order_not_payable' };
  if (String(query.invoice_payload || '') !== String(order.payload || '')) return { ok: false, reason: 'payload_mismatch' };
  if (query.currency !== 'XTR') return { ok: false, reason: 'currency_mismatch' };
  if (Number(query.total_amount) !== Number(order.totalAmount ?? order.amount)) return { ok: false, reason: 'amount_mismatch' };
  if (Number(query.from?.id) !== Number(order.userId)) return { ok: false, reason: 'user_mismatch' };
  return { ok: true, reason: 'ok' };
}

export function validateSuccessfulPayment(order, message = {}) {
  const payment = message.successful_payment;
  if (!order || !payment) return { ok: false, reason: 'order_or_payment_missing' };
  if (String(payment.invoice_payload || '') !== String(order.payload || '')) return { ok: false, reason: 'payload_mismatch' };
  if (payment.currency !== 'XTR') return { ok: false, reason: 'currency_mismatch' };
  const totalAmount = Number(order.totalAmount ?? order.amount);
  if (Number(payment.total_amount) !== totalAmount) return { ok: false, reason: 'amount_mismatch' };
  if (Number(message.from?.id) !== Number(order.userId)) return { ok: false, reason: 'user_mismatch' };
  const chargeId = String(payment.telegram_payment_charge_id || '').trim();
  if (!chargeId) return { ok: false, reason: 'charge_id_missing' };
  return {
    ok: true,
    reason: 'ok',
    chargeId,
    totalAmount,
    baseAmount: Number(order.baseAmount ?? order.amount)
  };
}

export function buildPreCheckoutWebhookReply(queryId, validation) {
  if (validation?.ok) {
    return {
      method: 'answerPreCheckoutQuery',
      pre_checkout_query_id: queryId,
      ok: true
    };
  }
  return {
    method: 'answerPreCheckoutQuery',
    pre_checkout_query_id: queryId,
    ok: false,
    error_message: 'Не удалось проверить заказ. Вернись в бот и создай новый платёж.'
  };
}

export function nextAlertSequence(value) {
  const n = Math.trunc(Number(value));
  return Number.isFinite(n) && n >= 0 ? n + 1 : 1;
}

export function validateRefundedPayment(order, record, refund = {}) {
  const chargeId = String(refund.telegram_payment_charge_id || '').trim();
  const payload = String(refund.invoice_payload || '');
  if (!chargeId || !payload) return { ok: false, reason: 'refund_identity_missing' };
  if (refund.currency !== 'XTR') return { ok: false, reason: 'currency_mismatch' };
  if (order?.payload && String(order.payload) !== payload) return { ok: false, reason: 'payload_mismatch' };
  if (record?.payload && String(record.payload) !== payload) return { ok: false, reason: 'payload_mismatch' };
  if (order?.telegramPaymentChargeId && String(order.telegramPaymentChargeId) !== chargeId) return { ok: false, reason: 'charge_id_mismatch' };
  if (record?.chargeId && String(record.chargeId) !== chargeId) return { ok: false, reason: 'charge_id_mismatch' };
  const expected = Number(record?.totalAmount ?? order?.totalAmount ?? order?.amount);
  if (Number.isFinite(expected) && Number(refund.total_amount) !== expected) return { ok: false, reason: 'amount_mismatch' };
  return { ok: true, reason: 'ok', chargeId, payload, totalAmount: expected };
}
