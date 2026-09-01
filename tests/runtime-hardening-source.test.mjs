import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const worker = await readFile(new URL('../src/index.js', import.meta.url), 'utf8');
const overlay = await readFile(new URL('../public/overlay.html', import.meta.url), 'utf8');
const goal = await readFile(new URL('../public/goal.html', import.meta.url), 'utf8');
const wrangler = await readFile(new URL('../wrangler.jsonc', import.meta.url), 'utf8');

test('Telegram webhook failures return retryable 5xx instead of 200', () => {
  assert.match(worker, /temporary_processing_failure/);
  assert.match(worker, /503/);
});

test('payment idempotency is permanent per Telegram charge id and old rolling charges array is gone', () => {
  assert.match(worker, /payment:\$\{chargeId\}/);
  assert.doesNotMatch(worker, /storage\.get\(["']charges["']\)/);
  assert.match(worker, /delivery:\s*["']pending["']/);
});

test('setup claim and Telegram webhook secrets are separated with APP_SECRET fallback migration', () => {
  assert.match(worker, /TELEGRAM_WEBHOOK_SECRET/);
  assert.match(worker, /CLAIM_SECRET/);
  assert.match(worker, /SETUP_SECRET/);
  assert.match(worker, /APP_SECRET/);
});

test('pre-checkout answer is returned directly in webhook response, not a second Bot API fetch', () => {
  assert.match(worker, /buildPreCheckoutWebhookReply/);
  assert.doesNotMatch(worker, /tg\(this\.env,\s*["']answerPreCheckoutQuery["']/);
});

test('refund path stores refunded state and refreshes goal balance', () => {
  assert.match(worker, /refundStarPayment/);
  assert.match(worker, /refunded_payment/);
  assert.match(worker, /status\s*[:=]\s*["']refunded["']/);
});

test('WebSocket heartbeat uses hibernation auto-response', () => {
  assert.match(worker, /setWebSocketAutoResponse/);
  assert.match(worker, /WebSocketRequestResponsePair\(["']ping["'],\s*["']pong["']\)/);
});

test('goal widget uses WebSocket realtime plus slow non-forced fallback refresh', () => {
  assert.doesNotMatch(goal, /refresh\(true\)/);
  assert.doesNotMatch(goal, /refresh=1/);
  assert.match(goal, /120000/);
});

test('overlay reconnect cursor uses persistent alert sequence rather than timestamp', () => {
  assert.match(overlay, /lastSeenSeq/);
  assert.match(overlay, /alert\.seq/);
  assert.doesNotMatch(overlay, /lastSeen\s*=\s*Math\.max\(lastSeen,\s*Number\(alert\.ts\)\)/);
});

test('TTS errors are visible in console/debug status rather than silently swallowed', () => {
  assert.match(overlay, /TTS error/);
  assert.match(overlay, /console\.error\(["']starchik TTS/);
});

test('stale unpaid invoices are cleaned lazily and invoice creation is rate-limited', () => {
  assert.match(worker, /cleanupStaleOrders/);
  assert.match(worker, /invoiceRate:/);
});

test('static assets use selective worker-first routing instead of charging Worker for every asset', () => {
  assert.match(wrangler, /"run_worker_first"\s*:\s*\[/);
  assert.doesNotMatch(wrangler, /"run_worker_first"\s*:\s*true/);
});

test('v5 overlay migrates the old timestamp cursor so the first post-upgrade donation is not lost', () => {
  assert.match(overlay, /starchik_last_seen_\$\{layout\}/);
  assert.match(overlay, /legacyLastSeenTs/);
  assert.match(overlay, /Number\(x\.ts\s*\|\|\s*0\)\s*>\s*legacyLastSeenTs/);
});

test('webhook secret migration accepts legacy APP_SECRET until it is removed', () => {
  assert.match(worker, /acceptedSecrets/);
  assert.match(worker, /dedicatedWebhookSecret/);
  assert.match(worker, /legacyWebhookSecret/);
});

test('invoice spam cooldown is recorded only after sendInvoice succeeds so webhook retries are not swallowed', () => {
  const start = worker.indexOf('async createInvoice');
  const end = worker.indexOf('async handlePreCheckout', start);
  const section = worker.slice(start, end);
  const sendInvoice = section.indexOf('"sendInvoice"');
  const rateWrite = section.indexOf('storage.put(invoiceRateKey, now)');
  assert.ok(sendInvoice >= 0 && rateWrite > sendInvoice, 'rate-limit timestamp must be written after successful sendInvoice');
});

test('ordinary Telegram updates are atomically reserved before any bot side effects', () => {
  const start = worker.indexOf('async handleTelegram');
  const end = worker.indexOf('async handleMessage', start);
  const section = worker.slice(start, end);
  const reserve = section.indexOf('reserveTelegramUpdate');
  const callback = section.indexOf('handleCallback');
  const message = section.indexOf('handleMessage');
  assert.ok(reserve >= 0, 'handleTelegram must reserve ordinary updates');
  assert.ok(reserve < callback, 'reservation must happen before callback side effects');
  assert.ok(reserve < message, 'reservation must happen before message side effects');
  assert.match(section, /isPaymentCriticalUpdate/);
  assert.match(section, /duplicate Telegram update suppressed/);
});

test('payment thank-you receipt is transactionally claimed before sendMessage to suppress concurrent retries', () => {
  const start = worker.indexOf('async sendPaymentReceipt');
  const end = worker.indexOf('async handleSuccessfulPayment', start);
  const section = worker.slice(start, end);
  const claim = section.indexOf('claimPaymentReceipt');
  const send = section.indexOf('sendMessage');
  assert.ok(claim >= 0 && send > claim, 'payment receipt must be claimed before sending Telegram message');
});
