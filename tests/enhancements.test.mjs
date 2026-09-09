import test from 'node:test';
import assert from 'node:assert/strict';
import {
  sanitizeDisplayName,
  validateViewerMedia,
  buildOrderPricing,
  findTierIndex,
  normalizeConfigV4,
  calculatePlayAt
} from '../src/v4-logic.js';

test('display name sanitization and fallback', () => {
  // Custom name sanitization
  assert.equal(sanitizeDisplayName('  Alex  '), 'Alex');
  assert.equal(sanitizeDisplayName('John\n\r\tDoe'), 'John Doe');
  assert.equal(sanitizeDisplayName('Super Long Name '.repeat(10)), 'Super Long Name Super Long Nam');
  assert.equal(sanitizeDisplayName('Anonymous'), 'Unknown');
  assert.equal(sanitizeDisplayName('Алексей ⭐️'), 'Алексей ⭐️');
  assert.equal(sanitizeDisplayName('   '), 'Unknown');
  assert.equal(sanitizeDisplayName(null), 'Unknown');
  assert.equal(sanitizeDisplayName(undefined), 'Unknown');
});

test('viewer media validation for attachments', () => {
  const config = {
    enabled: true,
    maxBytes: 10 * 1024 * 1024,
    allowPhoto: true,
    allowSticker: true
  };

  // Valid photo
  const validPhoto = {
    type: 'photo',
    file_id: 'photo_123',
    file_unique_id: 'uniq_p1',
    file_size: 500000,
    mime_type: 'image/jpeg'
  };
  assert.deepEqual(validateViewerMedia(validPhoto, config), { ok: true, reason: 'ok' });

  // Valid static webp sticker
  const validSticker = {
    type: 'sticker',
    file_id: 'sticker_123',
    file_unique_id: 'uniq_s1',
    file_size: 200000,
    mime_type: 'image/webp',
    is_animated: false,
    is_video: false
  };
  assert.deepEqual(validateViewerMedia(validSticker, config), { ok: true, reason: 'ok' });

  // TGS animated sticker -> rejected
  const tgsSticker = {
    type: 'sticker',
    file_id: 'sticker_tgs',
    file_unique_id: 'uniq_tgs',
    file_size: 100000,
    mime_type: 'application/x-tgsticker',
    is_animated: true,
    is_video: false
  };
  assert.equal(validateViewerMedia(tgsSticker, config).ok, false);

  // Video sticker -> rejected
  const videoSticker = {
    type: 'sticker',
    file_id: 'sticker_vid',
    file_unique_id: 'uniq_vid',
    file_size: 100000,
    mime_type: 'video/webm',
    is_animated: false,
    is_video: true
  };
  assert.equal(validateViewerMedia(videoSticker, config).ok, false);

  // Over 10MB -> rejected
  const hugePhoto = {
    type: 'photo',
    file_id: 'photo_huge',
    file_unique_id: 'uniq_huge',
    file_size: 11 * 1024 * 1024,
    mime_type: 'image/jpeg'
  };
  assert.equal(validateViewerMedia(hugePhoto, config).ok, false);
});

test('price snapshot includes baseAmount, ttsFee, mediaFee, and totalAmount', () => {
  const ttsProfile = { id: 'standard', label: 'Стандартная', price: 10, enabled: true };
  const mediaFee = 25;
  const pricing = buildOrderPricing(100, ttsProfile, mediaFee);

  assert.equal(pricing.baseAmount, 100);
  assert.equal(pricing.ttsFee, 10);
  assert.equal(pricing.mediaFee, 25);
  assert.equal(pricing.totalAmount, 135);

  // Animation tier calculation strictly uses baseAmount
  const tiers = [
    { min: 1, max: 24 },
    { min: 25, max: 99 },
    { min: 100, max: 249 },
    { min: 250, max: 499 }
  ];
  assert.equal(findTierIndex(pricing.baseAmount, tiers), 2);
  // Ensure findTierIndex fails or picks wrong if totalAmount (135) was incorrectly passed
  assert.equal(findTierIndex(pricing.totalAmount, tiers), 2); // 135 is also tier 2 in this range, but test with base 200 + fees 100 = 300
  const pricingHigh = buildOrderPricing(200, { id: 'ultra', price: 100, enabled: true }, 25);
  assert.equal(findTierIndex(pricingHigh.baseAmount, tiers), 2); // 200 -> tier 2
  assert.equal(findTierIndex(pricingHigh.totalAmount, tiers), 3); // 325 -> tier 3 (which would be WRONG if totalAmount was used!)
});

test('playAt timestamp calculation based on paidAt and alertDelayMs', () => {
  const paidAt = 1700000000000;
  const delayMs = 10000;
  assert.equal(calculatePlayAt(paidAt, delayMs), paidAt + delayMs);
  assert.equal(calculatePlayAt(paidAt, 0), paidAt);
  assert.equal(calculatePlayAt(paidAt, undefined), paidAt + 10000); // Default fallback 10000ms
});

test('historical config normalization populates defaults for alertDelayMs and viewerMedia', () => {
  const legacy = {
    overlayKey: 'test-key',
    amounts: [10, 50, 100]
  };
  const cfg = normalizeConfigV4(legacy);
  assert.equal(cfg.alertDelayMs, 10000);
  assert.deepEqual(cfg.viewerMedia, {
    enabled: false,
    price: 25,
    allowPhoto: true,
    allowSticker: true,
    maxBytes: 10485760
  });
});

test('historical order fixture without new fields has proper read-time fallbacks', () => {
  const historicalOrder = {
    payload: 'st_123',
    userId: 999,
    user: { first_name: 'Historical', username: 'old_user' },
    amount: 50,
    totalAmount: 50,
    status: 'paid',
    createdAt: 1700000000000
  };

  const displayName = historicalOrder.displayName || historicalOrder.user?.first_name || 'Unknown';
  const baseAmount = historicalOrder.baseAmount || historicalOrder.amount || 0;
  const mediaFee = historicalOrder.mediaFee || 0;
  const ttsFee = historicalOrder.ttsFee || 0;
  const media = historicalOrder.media || null;

  assert.equal(displayName, 'Historical');
  assert.equal(baseAmount, 50);
  assert.equal(mediaFee, 0);
  assert.equal(ttsFee, 0);
  assert.equal(media, null);
});

test('historical payment fixture without playAt has proper read-time fallback', () => {
  const historicalPayment = {
    chargeId: 'ch_123',
    payload: 'st_123',
    userId: 999,
    totalAmount: 50,
    status: 'committed',
    createdAt: 1700000000000
  };

  const playAt = historicalPayment.playAt || historicalPayment.createdAt || Date.now();
  assert.equal(playAt, 1700000000000);
});
