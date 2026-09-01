import test from 'node:test';
import assert from 'node:assert/strict';
import * as logic from '../src/v4-logic.js';

test('pre-checkout validation checks payload order, XTR amount, user and unpaid status', () => {
  assert.equal(typeof logic.validatePreCheckout, 'function');
  const order = { payload: 'p1', userId: 42, totalAmount: 110, status: 'invoice_sent' };
  assert.deepEqual(logic.validatePreCheckout(order, {
    id: 'q1', invoice_payload: 'p1', currency: 'XTR', total_amount: 110, from: { id: 42 }
  }), { ok: true, reason: 'ok' });
  assert.equal(logic.validatePreCheckout(order, { invoice_payload: 'p1', currency: 'USD', total_amount: 110, from: { id: 42 } }).ok, false);
  assert.equal(logic.validatePreCheckout(order, { invoice_payload: 'p1', currency: 'XTR', total_amount: 111, from: { id: 42 } }).ok, false);
  assert.equal(logic.validatePreCheckout(order, { invoice_payload: 'p1', currency: 'XTR', total_amount: 110, from: { id: 99 } }).ok, false);
  assert.equal(logic.validatePreCheckout({ ...order, status: 'paid' }, { invoice_payload: 'p1', currency: 'XTR', total_amount: 110, from: { id: 42 } }).ok, false);
});

test('successful payment validation requires XTR, expected amount/user and Telegram charge id', () => {
  assert.equal(typeof logic.validateSuccessfulPayment, 'function');
  const order = { payload: 'p1', userId: 42, baseAmount: 100, totalAmount: 110, status: 'invoice_sent' };
  const message = { from: { id: 42 }, successful_payment: {
    invoice_payload: 'p1', currency: 'XTR', total_amount: 110, telegram_payment_charge_id: 'charge-1'
  }};
  assert.equal(logic.validateSuccessfulPayment(order, message).ok, true);
  assert.equal(logic.validateSuccessfulPayment(order, { ...message, from: { id: 99 } }).ok, false);
  assert.equal(logic.validateSuccessfulPayment(order, { ...message, successful_payment: { ...message.successful_payment, total_amount: 109 } }).ok, false);
  assert.equal(logic.validateSuccessfulPayment(order, { ...message, successful_payment: { ...message.successful_payment, telegram_payment_charge_id: '' } }).ok, false);
});

test('direct webhook pre-checkout reply is valid Bot API payload', () => {
  assert.equal(typeof logic.buildPreCheckoutWebhookReply, 'function');
  assert.deepEqual(logic.buildPreCheckoutWebhookReply('q1', { ok: true, reason: 'ok' }), {
    method: 'answerPreCheckoutQuery',
    pre_checkout_query_id: 'q1',
    ok: true
  });
  const denied = logic.buildPreCheckoutWebhookReply('q2', { ok: false, reason: 'amount_mismatch' });
  assert.equal(denied.method, 'answerPreCheckoutQuery');
  assert.equal(denied.ok, false);
  assert.match(denied.error_message, /заказ/i);
});

test('alert sequence is monotonic even from missing or invalid persisted value', () => {
  assert.equal(typeof logic.nextAlertSequence, 'function');
  assert.equal(logic.nextAlertSequence(undefined), 1);
  assert.equal(logic.nextAlertSequence(7), 8);
  assert.equal(logic.nextAlertSequence(-4), 1);
});


test('refunded payment validation matches charge, payload, XTR and original amount', () => {
  assert.equal(typeof logic.validateRefundedPayment, 'function');
  const order = { payload: 'p1', totalAmount: 110, telegramPaymentChargeId: 'charge-1' };
  const record = { chargeId: 'charge-1', payload: 'p1', totalAmount: 110 };
  const valid = { currency: 'XTR', total_amount: 110, invoice_payload: 'p1', telegram_payment_charge_id: 'charge-1' };
  assert.equal(logic.validateRefundedPayment(order, record, valid).ok, true);
  assert.equal(logic.validateRefundedPayment(order, record, { ...valid, total_amount: 109 }).ok, false);
  assert.equal(logic.validateRefundedPayment(order, record, { ...valid, currency: 'USD' }).ok, false);
  assert.equal(logic.validateRefundedPayment(order, record, { ...valid, telegram_payment_charge_id: 'charge-2' }).ok, false);
  assert.equal(logic.validateRefundedPayment(order, record, { ...valid, invoice_payload: 'p2' }).ok, false);
});
