import test from 'node:test';
import assert from 'node:assert/strict';
import { claimPaymentReceipt } from '../src/payment-receipt.js';

class FakeStorage {
  constructor(record) {
    this.data = new Map([[`payment:${record.chargeId}`, structuredClone(record)]]);
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
        put: async (key, value) => this.data.set(key, structuredClone(value))
      };
      return await fn(txn);
    } finally {
      release();
    }
  }
}

test('four concurrent retries can claim a payment receipt only once', async () => {
  const storage = new FakeStorage({ chargeId: 'charge-1', receiptSent: false, status: 'committed' });
  const results = await Promise.all([
    claimPaymentReceipt(storage, 'charge-1', 1000),
    claimPaymentReceipt(storage, 'charge-1', 1001),
    claimPaymentReceipt(storage, 'charge-1', 1002),
    claimPaymentReceipt(storage, 'charge-1', 1003)
  ]);
  assert.equal(results.filter(x => x.claimed).length, 1);
  assert.equal(results.filter(x => !x.claimed).length, 3);
});

test('already sent or refunded payment receipts are never claimed', async () => {
  const sent = new FakeStorage({ chargeId: 'charge-sent', receiptSent: true, status: 'committed' });
  assert.equal((await claimPaymentReceipt(sent, 'charge-sent')).claimed, false);

  const refunded = new FakeStorage({ chargeId: 'charge-refund', receiptSent: false, status: 'refunded' });
  assert.equal((await claimPaymentReceipt(refunded, 'charge-refund')).claimed, false);
});
