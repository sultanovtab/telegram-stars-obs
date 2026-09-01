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

export function buildOrderPricing(baseAmount, profile = null) {
  const base = Math.max(1, Math.trunc(Number(baseAmount) || 0));
  if (!profile?.enabled) {
    return { baseAmount: base, ttsFee: 0, totalAmount: base, tts: null };
  }
  const fee = Math.max(0, Math.trunc(Number(profile.price) || 0));
  return {
    baseAmount: base,
    ttsFee: fee,
    totalAmount: base + fee,
    tts: {
      id: String(profile.id || 'standard'),
      label: String(profile.label || 'Озвучка'),
      price: fee,
      lang: String(profile.lang || 'ru-RU'),
      rate: Number(profile.rate) || 1,
      pitch: Number(profile.pitch) || 1,
      voiceName: String(profile.voiceName || '')
    }
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
