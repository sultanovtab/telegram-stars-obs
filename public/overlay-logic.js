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

export function prepareKaraokeMarkup(text = '') {
  const clean = String(text || '').trim();
  if (!clean) return { html: '', words: [] };
  const words = [];
  const tokens = clean.split(/(\s+)/);
  let charIndex = 0;
  let html = '';

  for (const token of tokens) {
    if (/\s+/.test(token)) {
      html += token;
      charIndex += token.length;
    } else {
      const start = charIndex;
      const end = charIndex + token.length;
      words.push({ start, end, text: token });
      html += `<span class="k-word" data-start="${start}" data-end="${end}">${token}</span>`;
      charIndex += token.length;
    }
  }

  return { html, words };
}
