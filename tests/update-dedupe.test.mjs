import test from 'node:test';
import assert from 'node:assert/strict';
import {
  telegramUpdateFingerprint,
  isPaymentCriticalUpdate,
  reserveTelegramUpdate
} from '../src/update-dedupe.js';

class FakeStorage {
  constructor(initial = {}) {
    this.data = new Map(Object.entries(initial));
    this.queue = Promise.resolve();
  }

  async transaction(fn) {
    let release;
    const previous = this.queue;
    this.queue = new Promise(resolve => { release = resolve; });
    await previous;
    try {
      const txn = {
        get: async key => this.data.get(key),
        put: async (key, value) => {
          if (typeof key === 'object' && value === undefined) {
            for (const [k, v] of Object.entries(key)) this.data.set(k, structuredClone(v));
          } else {
            this.data.set(key, structuredClone(value));
          }
        }
      };
      return await fn(txn);
    } finally {
      release();
    }
  }
}

test('fingerprint is stable for retried Telegram message/callback deliveries', () => {
  assert.equal(telegramUpdateFingerprint({ update_id: 1, message: { message_id: 44, chat: { id: 99 } } }), 'message:99:44');
  assert.equal(telegramUpdateFingerprint({ update_id: 2, callback_query: { id: 'cb-123' } }), 'callback:cb-123');
  assert.equal(telegramUpdateFingerprint({ update_id: 777 }), 'update:777');
});

test('payment-critical updates are not early-reserved', () => {
  assert.equal(isPaymentCriticalUpdate({ pre_checkout_query: { id: 'q1' } }), true);
  assert.equal(isPaymentCriticalUpdate({ message: { successful_payment: {} } }), true);
  assert.equal(isPaymentCriticalUpdate({ message: { refunded_payment: {} } }), true);
  assert.equal(isPaymentCriticalUpdate({ message: { text: '/admin' } }), false);
});

test('four concurrent retries of one ordinary update reserve exactly once', async () => {
  const storage = new FakeStorage();
  const update = { update_id: 500, message: { message_id: 77, chat: { id: 42 }, text: '/admin' } };
  const results = await Promise.all([
    reserveTelegramUpdate(storage, update),
    reserveTelegramUpdate(storage, update),
    reserveTelegramUpdate(storage, update),
    reserveTelegramUpdate(storage, update)
  ]);
  assert.equal(results.filter(Boolean).length, 1);
  assert.equal(results.filter(x => !x).length, 3);
});

test('legacy processedUpdates suppresses old Telegram retries during v5.1 rollout', async () => {
  const storage = new FakeStorage({ processedUpdates: [9001] });
  const update = { update_id: 9001, message: { message_id: 88, chat: { id: 42 }, text: '/admin' } };
  assert.equal(await reserveTelegramUpdate(storage, update), false);
});
