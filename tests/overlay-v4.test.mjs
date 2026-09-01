import test from 'node:test';
import assert from 'node:assert/strict';
import { estimateVisibleMs, ttsTimeoutMs } from '../public/overlay-logic.js';

test('short comments retain the tier minimum duration', () => {
  assert.equal(estimateVisibleMs('Спасибо!', 7000), 7000);
});

test('long comments stay visible longer than a short fixed alert', () => {
  const text = 'Это длинное сообщение, которое зритель должен успеть спокойно прочитать до того, как алерт исчезнет с экрана полностью.';
  assert.ok(estimateVisibleMs(text, 6000) > 9000);
});

test('TTS timeout allows speech longer than visual reading estimate without hanging forever', () => {
  const text = 'Очень длинное сообщение для проверки таймаута озвучки и безопасного завершения алерта.';
  assert.ok(ttsTimeoutMs(text) > estimateVisibleMs(text, 0));
  assert.ok(ttsTimeoutMs(text) < 30000);
});
