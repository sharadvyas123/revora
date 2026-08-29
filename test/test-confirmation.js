/**
 * @file test/test-confirmation.js
 * @description Automated test suite for Phase 13 — Explicit Purchase Confirmation Gate.
 *
 * Covers:
 *   1. Unit: MandateService.confirmCartMandate()
 *      - Confirm (user_confirmation: true) sets EXPLICIT_CONFIRMED
 *      - Reject (user_confirmation: false) sets REJECTED
 *      - Not-found cart mandate throws CHAIN_BROKEN
 *      - Invalid state (USED mandate) throws INVALID_STATE_TRANSITION
 *      - Confirmation fields persisted in DB (confirmed_at, channel, phrase)
 *   2. Unit: PaymentService.executePayment() confirmation gate
 *      - BLOCKED when confirmation_status is PENDING (default)
 *      - BLOCKED when confirmation_status is REJECTED
 *      - SUCCEEDS when confirmation_status is EXPLICIT_CONFIRMED
 *   3. Unit: MandateService._formatMandate() exposes confirmation fields
 *   4. Integration: HTTP endpoint POST /api/v1/mandates/cart/confirm
 *      - 200 with user_confirmation: true
 *      - 200 with user_confirmation: false
 *      - 400 validation error (missing fields)
 *      - 400 validation error (invalid channel enum)
 *
 * Run with:
 *   node test/test-confirmation.js
 *   (integration tests require server on localhost:3000)
 */

'use strict';

const http = require('http');
const path = require('path');

// ── ANSI colours ─────────────────────────────────────────────────────
const RESET = '\x1b[0m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';
const BOLD = '\x1b[1m';

// ── Test runner ───────────────────────────────────────────────────────
let passed = 0;
let failed = 0;
let skipped = 0;
const failures = [];

function pass(name) {
  passed++;
  console.log(`  ${GREEN}✔${RESET} ${name}`);
}
function fail(name, reason) {
  failed++;
  failures.push({ name, reason });
  console.log(`  ${RED}✘ ${name}${RESET}`);
  console.log(`      ${RED}→ ${reason}${RESET}`);
}
function skip(name, reason) {
  skipped++;
  console.log(`  ${YELLOW}○ SKIP${RESET} ${name} — ${reason}`);
}
function section(title) {
  console.log(`\n${BOLD}${CYAN}▶ ${title}${RESET}`);
}
function assert(name, condition, message) {
  condition ? pass(name) : fail(name, message || 'Assertion failed');
}

// ── HTTP helpers ─────────────────────────────────────────────────────
function httpPost(urlPath, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request({
      hostname: 'localhost', port: 3000, path: urlPath, method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        ...headers,
      },
    }, (res) => {
      let d = '';
      res.on('data', (c) => d += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(d) }); }
        catch { resolve({ status: res.statusCode, body: d }); }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function httpGet(urlPath, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: 'localhost', port: 3000, path: urlPath, method: 'GET',
      headers: { ...headers },
    }, (res) => {
      let d = '';
      res.on('data', (c) => d += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(d) }); }
        catch { resolve({ status: res.statusCode, body: d }); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// ── Database & service setup (uses real DB, same as test-coupon.js) ──
function buildTestDb() {
  const Database = require('better-sqlite3');
  const dbPath = path.resolve(__dirname, '..', 'data', 'acg.sqlite');
  const db = new Database(dbPath);
  db.pragma('foreign_keys = ON');
  return db;
}

function createServices(db) {
  const AuditService = require(path.resolve(__dirname, '../gateway/services/audit.service'));
  const CouponService = require(path.resolve(__dirname, '../gateway/services/coupon.service'));
  const MandateService = require(path.resolve(__dirname, '../gateway/services/mandate.service'));
  const PaymentService = require(path.resolve(__dirname, '../gateway/services/payment.service'));
  const RazorpayWrapper = require(path.resolve(__dirname, '../lib/razorpay'));

  const auditService = new AuditService(db);
  const couponService = new CouponService(db, auditService);
  const mandateService = new MandateService(db, auditService, couponService);

  let keyId = process.env.RAZORPAY_KEY_ID;
  let keySecret = process.env.RAZORPAY_KEY_SECRET;
  if (!keyId || !keySecret) {
    try {
      const config = require(path.resolve(__dirname, '../config'));
      keyId = config.razorpay.keyId;
      keySecret = config.razorpay.keySecret;
    } catch { /* fallback */ }
  }
  const razorpay = new RazorpayWrapper({
    keyId: keyId || 'rzp_test_placeholder',
    keySecret: keySecret || 'test_secret_placeholder',
  });
  const paymentService = new PaymentService(db, razorpay, auditService);

  return { db, auditService, couponService, mandateService, paymentService };
}

// ── Seed test-specific data (INSERT OR IGNORE to be safe) ────────────
function seedTestData(db) {
  db.prepare(`INSERT OR IGNORE INTO merchants (merchant_id, name, rz_key_id, rz_key_secret, status, created_at, updated_at)
    VALUES ('merch_test_confirm', 'Test Confirm Store', 'rzp_test_x', 'sec_x', 'ACTIVE', datetime('now'), datetime('now'))`).run();
  db.prepare(`INSERT OR IGNORE INTO delegators (delegator_id, name, email, created_at)
    VALUES ('user_test_confirm', 'Test Confirm User', 'confirm@test.com', datetime('now'))`).run();
  db.prepare(`INSERT OR IGNORE INTO agents (agent_id, name, type, api_key, api_secret, delegator_id, status, created_at)
    VALUES ('agent_test_confirm', 'Test Confirm Agent', 'BUYER', 'test_key_confirm', 'test_sec_confirm', 'user_test_confirm', 'ACTIVE', datetime('now'))`).run();
  db.prepare(`INSERT OR IGNORE INTO products (
    product_id, merchant_id, name, category, price_amount, price_currency,
    stock_available, stock_quantity, created_at, updated_at
  ) VALUES (
    'prod_confirm_001', 'merch_test_confirm', 'Confirmation Test Shoe', 'footwear', 349900, 'INR',
    1, 500, datetime('now'), datetime('now')
  )`).run();
}

// ── Create a full mandate chain up to PAYMENT status ─────────────────
function createFullMandateChain(mandateService) {
  const intent = mandateService.createIntentMandate({
    delegator_id: 'user_test_confirm',
    agent_id: 'agent_test_confirm',
    constraints: { max_amount: 500000, currency: 'INR', allowed_categories: ['footwear'] },
    ttl: 3600,
  });

  const cart = mandateService.createCartMandate({
    intent_mandate_id: intent.mandate_id,
    agent_id: 'agent_test_confirm',
    items: [{ product_id: 'prod_confirm_001', quantity: 1 }],
    reasoning: { reason: 'Best match for test' },
  });

  const payment = mandateService.approveCartMandate(cart.mandate_id, 'user_test_confirm');

  return { intent, cart, payment };
}

// ── Cleanup: delete test mandates/transactions by prefix ─────────────
function cleanup(db) {
  // Delete test mandates created by this suite (delegator = user_test_confirm)
  db.prepare("DELETE FROM transactions WHERE delegator_id = 'user_test_confirm'").run();
  db.prepare("DELETE FROM mandates WHERE delegator_id = 'user_test_confirm'").run();
}

// ══════════════════════════════════════════════════════════════════════
//  UNIT TESTS
// ══════════════════════════════════════════════════════════════════════

async function runUnitTests() {
  console.log(`\n${BOLD}════════════════════════════════════════════════════════${RESET}`);
  console.log(`${BOLD}  Phase 13: Explicit Purchase Confirmation Gate Tests${RESET}`);
  console.log(`${BOLD}════════════════════════════════════════════════════════${RESET}`);

  const db = buildTestDb();
  const { mandateService, paymentService } = createServices(db);
  seedTestData(db);

  // ── Section 1: confirmCartMandate() — Confirm Flow ─────────────────
  section('1. MandateService.confirmCartMandate() — Confirm Flow');
  {
    const { cart } = createFullMandateChain(mandateService);

    const result = mandateService.confirmCartMandate({
      cart_mandate_id: cart.mandate_id,
      user_confirmation: true,
      channel: 'VOICE',
      confirmation_phrase: 'Yes, proceed with purchase',
    });

    assert('confirm returns EXPLICIT_CONFIRMED status',
      result.confirmation_status === 'EXPLICIT_CONFIRMED',
      `Expected EXPLICIT_CONFIRMED, got ${result.confirmation_status}`);

    assert('confirm returns ready_for_payment: true',
      result.ready_for_payment === true,
      `Expected ready_for_payment true, got ${result.ready_for_payment}`);

    assert('confirm returns confirmed_at timestamp',
      typeof result.confirmed_at === 'string' && result.confirmed_at.length > 0,
      `Expected ISO timestamp, got ${result.confirmed_at}`);

    assert('confirm returns correct mandate_id',
      result.mandate_id === cart.mandate_id,
      `Expected ${cart.mandate_id}, got ${result.mandate_id}`);

    // Verify DB persistence
    const row = db.prepare('SELECT * FROM mandates WHERE mandate_id = ?').get(cart.mandate_id);
    assert('DB: confirmation_status persisted as EXPLICIT_CONFIRMED',
      row.confirmation_status === 'EXPLICIT_CONFIRMED',
      `Expected EXPLICIT_CONFIRMED in DB, got ${row.confirmation_status}`);

    assert('DB: confirmed_at persisted',
      row.confirmed_at != null,
      `Expected confirmed_at to be set, got ${row.confirmed_at}`);

    assert('DB: confirmation_channel persisted as VOICE',
      row.confirmation_channel === 'VOICE',
      `Expected VOICE, got ${row.confirmation_channel}`);

    assert('DB: confirmation_phrase persisted',
      row.confirmation_phrase === 'Yes, proceed with purchase',
      `Expected phrase, got ${row.confirmation_phrase}`);
  }

  // ── Section 2: Reject flow ─────────────────────────────────────────
  section('2. MandateService.confirmCartMandate() — Reject Flow');
  {
    const { cart } = createFullMandateChain(mandateService);

    const result = mandateService.confirmCartMandate({
      cart_mandate_id: cart.mandate_id,
      user_confirmation: false,
      channel: 'TEXT',
      confirmation_phrase: 'No, cancel this',
    });

    assert('reject returns REJECTED status',
      result.confirmation_status === 'REJECTED',
      `Expected REJECTED, got ${result.confirmation_status}`);

    assert('reject returns ready_for_payment: false',
      result.ready_for_payment === false,
      `Expected ready_for_payment false, got ${result.ready_for_payment}`);

    assert('reject returns confirmed_at timestamp',
      typeof result.confirmed_at === 'string',
      `Expected ISO timestamp`);

    const row = db.prepare('SELECT * FROM mandates WHERE mandate_id = ?').get(cart.mandate_id);
    assert('DB: confirmation_status persisted as REJECTED',
      row.confirmation_status === 'REJECTED',
      `Expected REJECTED in DB, got ${row.confirmation_status}`);

    assert('DB: confirmation_channel persisted as TEXT',
      row.confirmation_channel === 'TEXT',
      `Expected TEXT, got ${row.confirmation_channel}`);
  }

  // ── Section 3: Error cases ─────────────────────────────────────────
  section('3. MandateService.confirmCartMandate() — Error Cases');
  {
    // Test: Not found
    try {
      mandateService.confirmCartMandate({
        cart_mandate_id: 'mdt_cart_nonexistent_xyz',
        user_confirmation: true,
        channel: 'API',
      });
      fail('not-found cart throws CHAIN_BROKEN', 'No error thrown');
    } catch (err) {
      assert('not-found cart throws CHAIN_BROKEN',
        err.code === 'CHAIN_BROKEN',
        `Expected CHAIN_BROKEN, got ${err.code}`);
    }

    // Test: Invalid state — USED cart
    const { cart } = createFullMandateChain(mandateService);
    db.prepare("UPDATE mandates SET status = 'USED' WHERE mandate_id = ?").run(cart.mandate_id);

    try {
      mandateService.confirmCartMandate({
        cart_mandate_id: cart.mandate_id,
        user_confirmation: true,
        channel: 'API',
      });
      fail('USED cart throws INVALID_STATE_TRANSITION', 'No error thrown');
    } catch (err) {
      assert('USED cart throws INVALID_STATE_TRANSITION',
        err.code === 'INVALID_STATE_TRANSITION',
        `Expected INVALID_STATE_TRANSITION, got ${err.code}`);
    }

    // Test: REJECTED status cart blocks re-confirm
    const chain2 = createFullMandateChain(mandateService);
    db.prepare("UPDATE mandates SET status = 'REJECTED' WHERE mandate_id = ?").run(chain2.cart.mandate_id);

    try {
      mandateService.confirmCartMandate({
        cart_mandate_id: chain2.cart.mandate_id,
        user_confirmation: true,
        channel: 'API',
      });
      fail('REJECTED cart throws INVALID_STATE_TRANSITION', 'No error thrown');
    } catch (err) {
      assert('REJECTED cart throws INVALID_STATE_TRANSITION',
        err.code === 'INVALID_STATE_TRANSITION',
        `Expected INVALID_STATE_TRANSITION, got ${err.code}`);
    }
  }

  // ── Section 4: Confirm on PENDING_APPROVAL cart ────────────────────
  section('4. MandateService.confirmCartMandate() — Works on PENDING_APPROVAL');
  {
    const intent = mandateService.createIntentMandate({
      delegator_id: 'user_test_confirm',
      agent_id: 'agent_test_confirm',
      constraints: { max_amount: 500000, currency: 'INR', allowed_categories: ['footwear'] },
      ttl: 3600,
    });
    const cart = mandateService.createCartMandate({
      intent_mandate_id: intent.mandate_id,
      agent_id: 'agent_test_confirm',
      items: [{ product_id: 'prod_confirm_001', quantity: 1 }],
    });

    assert('cart starts as PENDING_APPROVAL',
      cart.status === 'PENDING_APPROVAL',
      `Expected PENDING_APPROVAL, got ${cart.status}`);

    const result = mandateService.confirmCartMandate({
      cart_mandate_id: cart.mandate_id,
      user_confirmation: true,
      channel: 'API',
      confirmation_phrase: 'Confirmed via API',
    });

    assert('confirm on PENDING_APPROVAL returns EXPLICIT_CONFIRMED',
      result.confirmation_status === 'EXPLICIT_CONFIRMED',
      `Expected EXPLICIT_CONFIRMED, got ${result.confirmation_status}`);
  }

  // ── Section 5: _formatMandate exposes confirmation fields ──────────
  section('5. MandateService._formatMandate() — Confirmation Fields');
  {
    const { cart } = createFullMandateChain(mandateService);

    // Before confirmation
    const before = mandateService.getMandateById(cart.mandate_id);
    assert('before confirm: confirmation_status is PENDING',
      before.confirmation_status === 'PENDING',
      `Expected PENDING, got ${before.confirmation_status}`);

    assert('before confirm: no confirmed_at',
      before.confirmed_at === undefined,
      `Expected undefined, got ${before.confirmed_at}`);

    // After confirmation
    mandateService.confirmCartMandate({
      cart_mandate_id: cart.mandate_id,
      user_confirmation: true,
      channel: 'VOICE',
      confirmation_phrase: 'Yes go ahead',
    });

    const after = mandateService.getMandateById(cart.mandate_id);
    assert('after confirm: confirmation_status is EXPLICIT_CONFIRMED',
      after.confirmation_status === 'EXPLICIT_CONFIRMED',
      `Expected EXPLICIT_CONFIRMED, got ${after.confirmation_status}`);

    assert('after confirm: confirmed_at is set',
      typeof after.confirmed_at === 'string',
      `Expected string timestamp`);

    assert('after confirm: confirmation_channel is VOICE',
      after.confirmation_channel === 'VOICE',
      `Expected VOICE, got ${after.confirmation_channel}`);

    assert('after confirm: confirmation_phrase is set',
      after.confirmation_phrase === 'Yes go ahead',
      `Expected "Yes go ahead", got ${after.confirmation_phrase}`);
  }

  // ── Section 6: Payment Gate — BLOCKED when PENDING ─────────────────
  section('6. PaymentService.executePayment() — BLOCKED when PENDING (default)');
  {
    const { cart, payment } = createFullMandateChain(mandateService);

    try {
      await paymentService.executePayment({
        payment_mandate_id: payment.mandate_id,
        agent_id: 'agent_test_confirm',
      });
      fail('payment BLOCKED when PENDING', 'No error thrown — payment succeeded without confirmation!');
    } catch (err) {
      assert('payment BLOCKED with CONFIRMATION_REQUIRED code',
        err.code === 'CONFIRMATION_REQUIRED',
        `Expected CONFIRMATION_REQUIRED, got ${err.code}`);

      assert('payment BLOCKED with 403 statusCode',
        err.statusCode === 403,
        `Expected 403, got ${err.statusCode}`);

      assert('error details.mandate_id matches cart',
        err.details && err.details.mandate_id === cart.mandate_id,
        `Expected mandate_id ${cart.mandate_id} in details`);

      assert('error recovery suggests REQUEST_CONFIRMATION',
        err.recovery && err.recovery.action === 'REQUEST_CONFIRMATION',
        `Expected REQUEST_CONFIRMATION action`);
    }
  }

  // ── Section 7: Payment Gate — BLOCKED when REJECTED ────────────────
  section('7. PaymentService.executePayment() — BLOCKED when REJECTED');
  {
    const { cart, payment } = createFullMandateChain(mandateService);

    mandateService.confirmCartMandate({
      cart_mandate_id: cart.mandate_id,
      user_confirmation: false,
      channel: 'TEXT',
      confirmation_phrase: 'No thanks',
    });

    try {
      await paymentService.executePayment({
        payment_mandate_id: payment.mandate_id,
        agent_id: 'agent_test_confirm',
      });
      fail('payment BLOCKED when REJECTED', 'No error thrown');
    } catch (err) {
      assert('payment BLOCKED when REJECTED',
        err.code === 'CONFIRMATION_REQUIRED',
        `Expected CONFIRMATION_REQUIRED, got ${err.code}`);
    }
  }

  // ── Section 8: Payment Gate — SUCCEEDS when EXPLICIT_CONFIRMED ─────
  section('8. PaymentService.executePayment() — SUCCEEDS when EXPLICIT_CONFIRMED');
  {
    const { cart, payment } = createFullMandateChain(mandateService);

    mandateService.confirmCartMandate({
      cart_mandate_id: cart.mandate_id,
      user_confirmation: true,
      channel: 'VOICE',
      confirmation_phrase: 'Yes, buy it',
    });

    try {
      const txn = await paymentService.executePayment({
        payment_mandate_id: payment.mandate_id,
        agent_id: 'agent_test_confirm',
      });

      assert('payment succeeds after confirmation',
        txn.status === 'CAPTURED',
        `Expected CAPTURED, got ${txn.status}`);

      assert('payment has razorpay order_id',
        txn.razorpay && txn.razorpay.order_id != null,
        `Expected razorpay order_id`);

      assert('payment has transaction_id',
        typeof txn.transaction_id === 'string',
        `Expected transaction_id string`);

    } catch (err) {
      fail('payment succeeds after confirmation', `Threw unexpected error: ${err.code} — ${err.message}`);
    }
  }

  // ── Section 9: Channel values ──────────────────────────────────────
  section('9. Confirmation Channels — VOICE, TEXT, API');
  {
    const channels = ['VOICE', 'TEXT', 'API'];
    for (const ch of channels) {
      const { cart } = createFullMandateChain(mandateService);

      const result = mandateService.confirmCartMandate({
        cart_mandate_id: cart.mandate_id,
        user_confirmation: true,
        channel: ch,
      });

      assert(`channel ${ch} accepted and confirmed`,
        result.confirmation_status === 'EXPLICIT_CONFIRMED',
        `Expected EXPLICIT_CONFIRMED for channel ${ch}`);

      const row = db.prepare('SELECT confirmation_channel FROM mandates WHERE mandate_id = ?').get(cart.mandate_id);
      assert(`channel ${ch} persisted in DB`,
        row.confirmation_channel === ch,
        `Expected ${ch} in DB, got ${row.confirmation_channel}`);
    }
  }

  // ── Section 10: Optional confirmation_phrase ───────────────────────
  section('10. Optional confirmation_phrase — empty / null');
  {
    const { cart } = createFullMandateChain(mandateService);

    const result = mandateService.confirmCartMandate({
      cart_mandate_id: cart.mandate_id,
      user_confirmation: true,
      channel: 'API',
    });

    assert('confirm without phrase succeeds',
      result.confirmation_status === 'EXPLICIT_CONFIRMED',
      `Expected EXPLICIT_CONFIRMED`);

    const row = db.prepare('SELECT confirmation_phrase FROM mandates WHERE mandate_id = ?').get(cart.mandate_id);
    assert('DB: confirmation_phrase is null when omitted',
      row.confirmation_phrase == null,
      `Expected null, got ${row.confirmation_phrase}`);
  }

  // Cleanup unit test data
  cleanup(db);
  db.close();
}

// ══════════════════════════════════════════════════════════════════════
//  INTEGRATION TESTS (HTTP)
// ══════════════════════════════════════════════════════════════════════

async function runIntegrationTests() {
  section('11. Integration: POST /api/v1/mandates/cart/confirm');

  let serverUp = false;
  try {
    const health = await httpGet('/health');
    serverUp = health.status === 200;
  } catch {
    serverUp = false;
  }

  if (!serverUp) {
    skip('Server connectivity', 'Server not running on localhost:3000');
    skip('POST /cart/confirm with true', 'Server not running');
    skip('POST /cart/confirm with false', 'Server not running');
    skip('POST /cart/confirm missing fields', 'Server not running');
    skip('POST /cart/confirm invalid channel', 'Server not running');
    skip('POST /cart/confirm non-existent mandate', 'Server not running');
    return;
  }

  pass('Server connectivity');

  const agentId = 'agent_shopper_01';
  const authHeaders = { 'x-agent-id': agentId };

  // Step 1: Create intent
  let intentId, cartId;
  try {
    const intentRes = await httpPost('/api/v1/mandates/intent', {
      delegator_id: 'user_jane_doe',
      agent_id: agentId,
      constraints: { max_amount: 500000, currency: 'INR', allowed_categories: ['footwear'] },
      ttl: 3600,
    }, authHeaders);

    if (intentRes.status === 201 && intentRes.body.data) {
      intentId = intentRes.body.data.mandate_id;
    } else {
      skip('HTTP: create intent failed', `Status ${intentRes.status}`);
      return;
    }
  } catch (err) {
    skip('HTTP: create intent', err.message);
    return;
  }

  // Step 2: Create cart
  try {
    const cartRes = await httpPost('/api/v1/mandates/cart', {
      intent_mandate_id: intentId,
      agent_id: agentId,
      items: [{ product_id: 'prod_nike_pegasus', quantity: 1 }],
      reasoning: { reason: 'Test confirmation gate' },
    }, authHeaders);

    if (cartRes.status === 201 && cartRes.body.data) {
      cartId = cartRes.body.data.mandate_id;
    } else {
      skip('HTTP: create cart failed', `Status ${cartRes.status} — ${JSON.stringify(cartRes.body)}`);
      return;
    }
  } catch (err) {
    skip('HTTP: create cart', err.message);
    return;
  }

  // Step 3: Approve cart
  try {
    const approveRes = await httpPost(`/api/v1/mandates/cart/${cartId}/approve`, {
      approved_by: 'user_jane_doe',
    }, authHeaders);

    if (approveRes.status !== 200) {
      skip('HTTP: approve cart failed', `Status ${approveRes.status}`);
      return;
    }
  } catch (err) {
    skip('HTTP: approve cart', err.message);
    return;
  }

  // Test: Confirm with true
  try {
    const confirmRes = await httpPost('/api/v1/mandates/cart/confirm', {
      cart_mandate_id: cartId,
      user_confirmation: true,
      channel: 'TEXT',
      confirmation_phrase: 'Yes proceed',
    }, authHeaders);

    assert('HTTP POST /cart/confirm (true) returns 200',
      confirmRes.status === 200,
      `Expected 200, got ${confirmRes.status}`);

    assert('HTTP response has EXPLICIT_CONFIRMED',
      confirmRes.body.data && confirmRes.body.data.confirmation_status === 'EXPLICIT_CONFIRMED',
      `Expected EXPLICIT_CONFIRMED in response`);

    assert('HTTP response has ready_for_payment: true',
      confirmRes.body.data && confirmRes.body.data.ready_for_payment === true,
      `Expected ready_for_payment true`);

    assert('HTTP response message indicates success',
      confirmRes.body.message && confirmRes.body.message.includes('confirmed'),
      `Expected message to include "confirmed"`);
  } catch (err) {
    fail('HTTP POST /cart/confirm (true)', err.message);
  }

  // Create another chain for reject test
  section('12. Integration: POST /api/v1/mandates/cart/confirm — Reject');
  let cartId2;
  try {
    const intentRes2 = await httpPost('/api/v1/mandates/intent', {
      delegator_id: 'user_jane_doe',
      agent_id: agentId,
      constraints: { max_amount: 500000, currency: 'INR', allowed_categories: ['footwear'] },
      ttl: 3600,
    }, authHeaders);
    const intentId2 = intentRes2.body.data.mandate_id;

    const cartRes2 = await httpPost('/api/v1/mandates/cart', {
      intent_mandate_id: intentId2,
      agent_id: agentId,
      items: [{ product_id: 'prod_nike_pegasus', quantity: 1 }],
    }, authHeaders);
    cartId2 = cartRes2.body.data.mandate_id;

    await httpPost(`/api/v1/mandates/cart/${cartId2}/approve`, {
      approved_by: 'user_jane_doe',
    }, authHeaders);

    const rejectRes = await httpPost('/api/v1/mandates/cart/confirm', {
      cart_mandate_id: cartId2,
      user_confirmation: false,
      channel: 'VOICE',
      confirmation_phrase: 'No, cancel',
    }, authHeaders);

    assert('HTTP POST /cart/confirm (false) returns 200',
      rejectRes.status === 200,
      `Expected 200, got ${rejectRes.status}`);

    assert('HTTP response has REJECTED status',
      rejectRes.body.data && rejectRes.body.data.confirmation_status === 'REJECTED',
      `Expected REJECTED`);

    assert('HTTP response has ready_for_payment: false',
      rejectRes.body.data && rejectRes.body.data.ready_for_payment === false,
      `Expected ready_for_payment false`);
  } catch (err) {
    fail('HTTP POST /cart/confirm (false)', err.message);
  }

  // Test: Validation errors
  section('13. Integration: Validation Errors');

  try {
    const noFields = await httpPost('/api/v1/mandates/cart/confirm', {}, authHeaders);
    assert('missing fields returns 400',
      noFields.status === 400,
      `Expected 400, got ${noFields.status}`);
  } catch (err) {
    fail('missing fields returns 400', err.message);
  }

  try {
    const badChannel = await httpPost('/api/v1/mandates/cart/confirm', {
      cart_mandate_id: 'mdt_cart_any',
      user_confirmation: true,
      channel: 'INVALID_CHANNEL',
    }, authHeaders);
    assert('invalid channel enum returns 400',
      badChannel.status === 400,
      `Expected 400, got ${badChannel.status}`);
  } catch (err) {
    fail('invalid channel enum returns 400', err.message);
  }

  try {
    const notFound = await httpPost('/api/v1/mandates/cart/confirm', {
      cart_mandate_id: 'mdt_cart_nonexistent',
      user_confirmation: true,
      channel: 'API',
    }, authHeaders);
    assert('non-existent cart mandate returns 400 (CHAIN_BROKEN)',
      notFound.status === 400,
      `Expected 400, got ${notFound.status}`);
  } catch (err) {
    fail('non-existent mandate returns 400', err.message);
  }
}

// ══════════════════════════════════════════════════════════════════════
//  MAIN
// ══════════════════════════════════════════════════════════════════════

(async () => {
  try {
    await runUnitTests();
    await runIntegrationTests();
  } catch (err) {
    console.error(`\n${RED}FATAL: ${err.message}${RESET}`);
    console.error(err.stack);
    failed++;
  }

  // ── Summary ──────────────────────────────────────────────────────
  const total = passed + failed + skipped;
  console.log(`\n${BOLD}════════════════════════════════════════════════════════${RESET}`);
  console.log(`  ${GREEN}Passed:  ${passed}${RESET}`);
  console.log(`  ${RED}Failed:  ${failed}${RESET}`);
  console.log(`  ${YELLOW}Skipped: ${skipped}${RESET}`);
  console.log(`  Total:   ${total}`);
  console.log(`${BOLD}════════════════════════════════════════════════════════${RESET}`);

  if (failures.length > 0) {
    console.log(`\n${RED}${BOLD}Failed Tests:${RESET}`);
    for (const f of failures) {
      console.log(`  ${RED}✘ ${f.name}${RESET}`);
      console.log(`    → ${f.reason}`);
    }
  }

  console.log(`\n${passed}/${total} tests passed${failed > 0 ? ` (${failed} failed)` : ''}\n`);
  process.exit(failed > 0 ? 1 : 0);
})();
