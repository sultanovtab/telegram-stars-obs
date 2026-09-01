import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const worker = await readFile(new URL('../src/index.js', import.meta.url), 'utf8');
const overlay = await readFile(new URL('../public/overlay.html', import.meta.url), 'utf8');
const goal = await readFile(new URL('../public/goal.html', import.meta.url), 'utf8').catch(() => '');

test('worker exposes goal widget and live goal state routes', () => {
  assert.match(worker, /\/goal\/landscape/);
  assert.match(worker, /\/goal-state/);
  assert.match(worker, /goalAssetUrl/);
});

test('worker reads actual Telegram bot Star balance', () => {
  assert.match(worker, /getMyStarBalance/);
});

test('donation flow offers enabled TTS and stores base plus total pricing', () => {
  assert.match(worker, /tts:none/);
  assert.match(worker, /tts:/);
  assert.match(worker, /baseAmount/);
  assert.match(worker, /totalAmount/);
});

test('admin menu contains TTS, balance, and collection goal controls', () => {
  assert.match(worker, /Озвучка/);
  assert.match(worker, /Баланс/);
  assert.match(worker, /Цель сбора/);
});

test('OBS alert overlay uses speech synthesis and adaptive visibility', () => {
  assert.match(overlay, /speechSynthesis/);
  assert.match(overlay, /estimateVisibleMs/);
  assert.match(overlay, /ttsTimeoutMs/);
});

test('goal widget renders a progress bar from goal state', () => {
  assert.match(goal, /progress/);
  assert.match(goal, /goal-state/);
  assert.match(goal, /WebSocket/);
});
