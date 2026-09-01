import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_TTS_PROFILES,
  normalizeConfigV4,
  enabledTtsProfiles,
  buildOrderPricing,
  findTierIndex,
  goalProgress
} from '../src/v4-logic.js';

test('legacy v3 config migrates to v4 without losing media or overlay key', () => {
  const legacy = {
    overlayKey: 'keep-me',
    amounts: [10, 50, 100],
    origin: 'https://example.workers.dev',
    tiers: [
      { label: '1–24 ⭐', min: 1, max: 24, duration: 6000, animation: { fileId: 'gif1' }, sound: { fileId: 'snd1' } }
    ]
  };
  const cfg = normalizeConfigV4(legacy);
  assert.equal(cfg.overlayKey, 'keep-me');
  assert.deepEqual(cfg.amounts, [10, 50, 100]);
  assert.equal(cfg.tiers[0].animation.fileId, 'gif1');
  assert.equal(cfg.tiers[0].sound.fileId, 'snd1');
  assert.equal(cfg.ttsProfiles.length, 5);
  assert.equal(cfg.ttsProfiles[0].enabled, true);
  assert.equal(cfg.ttsProfiles[0].price, 10);
  assert.equal(cfg.ttsProfiles[1].enabled, false);
  assert.equal(cfg.goal.enabled, false);
  assert.equal(cfg.goal.target, 1000);
});

test('only enabled TTS profiles are shown to viewers', () => {
  const profiles = structuredClone(DEFAULT_TTS_PROFILES);
  profiles[0].enabled = true;
  profiles[1].enabled = false;
  profiles[2].enabled = true;
  assert.deepEqual(enabledTtsProfiles(profiles).map(x => x.id), ['standard', 'premium_plus']);
});

test('TTS surcharge changes invoice total but animation tier uses base donation', () => {
  const pricing = buildOrderPricing(100, { id: 'standard', label: 'Стандартная', price: 10, enabled: true });
  assert.equal(pricing.baseAmount, 100);
  assert.equal(pricing.ttsFee, 10);
  assert.equal(pricing.totalAmount, 110);
  assert.equal(findTierIndex(100, [
    { min: 1, max: 24 },
    { min: 25, max: 99 },
    { min: 100, max: 249 }
  ]), 2);
});

test('disabled TTS profile cannot add a surcharge', () => {
  const pricing = buildOrderPricing(100, { id: 'premium', label: 'Премиум', price: 25, enabled: false });
  assert.equal(pricing.ttsFee, 0);
  assert.equal(pricing.totalAmount, 100);
  assert.equal(pricing.tts, null);
});

test('goal progress is based on current bot balance and clamps visual percent', () => {
  assert.deepEqual(goalProgress(325, 1000), { current: 325, target: 1000, percent: 32.5 });
  assert.deepEqual(goalProgress(1400, 1000), { current: 1400, target: 1000, percent: 100 });
});

test('Telegram Stars invoice uses exactly one LabeledPrice containing the total', async () => {
  const { buildStarInvoicePrices } = await import('../src/v4-logic.js');
  const pricing = buildOrderPricing(100, { id:'standard', label:'Стандартная', price:10, enabled:true });
  assert.deepEqual(buildStarInvoicePrices(pricing), [{ label: 'Поддержка + озвучка', amount: 110 }]);
});
