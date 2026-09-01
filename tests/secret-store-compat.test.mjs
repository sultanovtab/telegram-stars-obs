import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../src/index.js', import.meta.url), 'utf8');

test('worker resolves plain Worker secrets and Secrets Store bindings', () => {
  assert.match(source, /async function resolveSecret\s*\(/, 'missing async resolveSecret helper');
  assert.match(source, /typeof value\.get === ["']function["']/, 'Secrets Store binding .get() is not handled');
});

test('Telegram token is not interpolated directly from env.BOT_TOKEN', () => {
  assert.doesNotMatch(source, /bot\$\{env\.BOT_TOKEN\}/, 'direct BOT_TOKEN interpolation breaks Secrets Store bindings');
});

test('APP_SECRET is not compared directly as an env object', () => {
  assert.doesNotMatch(source, /code !== env\.APP_SECRET|secret !== env\.APP_SECRET|code !== this\.env\.APP_SECRET/, 'direct APP_SECRET comparisons break Secrets Store bindings');
});
