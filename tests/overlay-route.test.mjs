import test from 'node:test';
import assert from 'node:assert/strict';
import { overlayAssetUrl } from '../src/overlay-route.js';

test('overlay asset rewrite preserves OBS key and debug query params', () => {
  const input = 'https://telegram-stars-obs.example.workers.dev/overlay/landscape?key=abc123&debug=1';
  assert.equal(
    overlayAssetUrl(input),
    'https://telegram-stars-obs.example.workers.dev/overlay.html?key=abc123&debug=1'
  );
});
