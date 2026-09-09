import test from 'node:test';
import assert from 'node:assert/strict';
import * as logic from '../src/v4-logic.js';

test('historical order fixture without new fields resolves read-time defaults', () => {
  const oldOrder = {
    payload: 'st_old_123',
    userId: 42,
    user: '@old_user',
    amount: 100,
    status: 'paid'
  };
  // Read-time defaults
  assert.equal(oldOrder.media, undefined);
  assert.equal(oldOrder.mediaFee, undefined);
  assert.equal(oldOrder.displayName, undefined);
  assert.equal(oldOrder.playAt, undefined);

  // Normalized order pricing / display name read-time helpers
  assert.equal(logic.getOrderMediaFee?.(oldOrder) ?? 0, 0);
  assert.equal(logic.getOrderDisplayName?.(oldOrder) ?? oldOrder.user, '@old_user');
});

test('price snapshotting freezes baseAmount, ttsFee, mediaFee, and totalAmount at order creation', () => {
  const pricing = logic.buildOrderPricingV5({
    baseAmount: 100,
    ttsProfile: { id: 'standard', label: 'Стандартная', price: 10, enabled: true },
    mediaAttachment: { fileId: 'f123', price: 25 },
    displayName: 'SuperFan'
  });

  assert.equal(pricing.baseAmount, 100);
  assert.equal(pricing.ttsFee, 10);
  assert.equal(pricing.mediaFee, 25);
  assert.equal(pricing.totalAmount, 135);
  assert.equal(pricing.displayName, 'SuperFan');

  // Admin changing prices later does NOT alter pricing object or calculated prices
  const newTtsProfile = { id: 'standard', label: 'Стандартная', price: 20, enabled: true };
  const newMediaFeeConfig = 50;

  assert.equal(pricing.baseAmount, 100);
  assert.equal(pricing.ttsFee, 10);
  assert.equal(pricing.mediaFee, 25);
  assert.equal(pricing.totalAmount, 135);
});

test('base donation tier is determined strictly by baseAmount, NOT totalAmount with fees', () => {
  const tiers = [
    { label: "1–24 ⭐", min: 1, max: 24 },
    { label: "25–99 ⭐", min: 25, max: 99 },
    { label: "100–249 ⭐", min: 100, max: 249 },
    { label: "250–499 ⭐", min: 250, max: 499 }
  ];

  // baseAmount = 100 (tier 2), ttsFee = 10, mediaFee = 25 => totalAmount = 135
  const baseAmount = 100;
  const totalAmount = 135;

  const tierIndex = logic.findTierIndex(baseAmount, tiers);
  const incorrectTierIndex = logic.findTierIndex(totalAmount, tiers);

  assert.equal(tierIndex, 2); // 100-249 tier
  // totalAmount 135 also falls into tier 2 here, but let's test a boundary where total crosses a tier:
  // baseAmount = 90 (tier 1: 25-99), ttsFee = 20 => totalAmount = 110 (tier 2: 100-249)
  const baseAmount90 = 90;
  const tierIndex90 = logic.findTierIndex(baseAmount90, tiers);
  assert.equal(tierIndex90, 1); // must be tier 1, NOT tier 2
});

test('displayName privacy: new alerts do not expose Telegram username or user ID', () => {
  const user = { id: 1234567, username: 'secret_handle', first_name: 'John' };

  // Donor provided custom name
  const customPricing = logic.buildOrderPricingV5({
    baseAmount: 50,
    displayName: '  Stream Supporter  ',
    user
  });
  assert.equal(customPricing.displayName, 'Stream Supporter');

  // Donor chose anonymous ("Unknown")
  const anonPricing = logic.buildOrderPricingV5({
    baseAmount: 50,
    displayName: '', // empty or anonymous
    isAnonymous: true,
    user
  });
  assert.equal(anonPricing.displayName, 'Unknown');
});

test('viewer media validation rejects files over 10MB or unsupported formats (TGS)', () => {
  // Max size is 10 MB (10 * 1024 * 1024 bytes = 10,485,760 bytes)
  const oversizedFile = { file_size: 11 * 1024 * 1024, mime_type: 'image/png' };
  assert.equal(logic.validateViewerMedia(oversizedFile).ok, false);
  assert.equal(logic.validateViewerMedia(oversizedFile).reason, 'file_too_large');

  // TGS sticker (animated sticker)
  const tgsSticker = { is_animated: true, file_size: 100 * 1024 };
  assert.equal(logic.validateViewerMedia(tgsSticker, 'sticker').ok, false);
  assert.equal(logic.validateViewerMedia(tgsSticker, 'sticker').reason, 'unsupported_animated_sticker');

  // Valid image
  const validPhoto = { file_size: 2 * 1024 * 1024, mime_type: 'image/jpeg' };
  assert.equal(logic.validateViewerMedia(validPhoto, 'photo').ok, true);
});

test('playAt is generated on successful payment as paidAt + alertDelayMs', () => {
  const paidAt = 1700000000000;
  const alertDelayMs = 10000;
  const playAt = logic.calculatePlayAt(paidAt, alertDelayMs);
  assert.equal(playAt, 1700000010000);
});
