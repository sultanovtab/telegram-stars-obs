export function estimateVisibleMs(text = '', tierMinimumMs = 0) {
  const clean = String(text || '').trim();
  if (!clean) return Math.max(1600, Number(tierMinimumMs) || 0);
  const words = clean.split(/\s+/).filter(Boolean).length;
  const byWords = 1700 + words * 520;
  const byChars = 1700 + clean.length * 78;
  const reading = Math.max(byWords, byChars);
  return Math.max(1600, Number(tierMinimumMs) || 0, reading);
}

export function ttsTimeoutMs(text = '') {
  const clean = String(text || '').trim();
  const estimated = estimateVisibleMs(clean, 0);
  return Math.min(28000, Math.max(5000, estimated + 6500));
}
