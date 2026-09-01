import test from 'node:test';
import assert from 'node:assert/strict';
import { overlayAssetUrl, goalAssetUrl } from '../src/overlay-route.js';

test('goal widget route keeps OBS key and other query parameters', () => {
  const input = 'https://example.workers.dev/goal/vertical?key=secret&debug=1';
  const output = new URL(goalAssetUrl(input));
  assert.equal(output.pathname, '/goal.html');
  assert.equal(output.searchParams.get('key'), 'secret');
  assert.equal(output.searchParams.get('debug'), '1');
});

test('alert overlay route still preserves query parameters', () => {
  const input = 'https://example.workers.dev/overlay/landscape?key=abc&preview=1';
  const output = new URL(overlayAssetUrl(input));
  assert.equal(output.pathname, '/overlay.html');
  assert.equal(output.searchParams.get('key'), 'abc');
  assert.equal(output.searchParams.get('preview'), '1');
});
