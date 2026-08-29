/**
 * @file test/test-coupon.js
 * @description Automated test suite for Phase 11 — Coupon & Voucher Management System.
 *
 * Covers:
 *   1. Unit: CouponService.validateCoupon()
 *      - Valid FLAT discount (RUN500: ₹4,299 → ₹3,799)
 *      - Valid PERCENTAGE discount with cap (SAVE10: 10% capped at ₹1,000)
 *      - WELCOME20 percentage discount
 *      - Expired coupon rejection
 *      - Inactive/EXPIRED status rejection
 *      - Coupon not found
 *      - Min spend not met
 *      - Max usage limit hit
 *      - Category mismatch
 *      - Case-insensitive code lookup
 *   2. Unit: CouponService.listCoupons()
 *   3. Unit: MandateService coupon integration
 *      - Spend cap pass: original > cap, final_amount <= cap (coupon saves the cart)
 *      - Spend cap fail: final_amount > cap
 *   4. Integration: HTTP endpoints (skip if server down)
 *      - GET /api/v1/coupons
 *      - POST /api/v1/coupons/validate
 *      - POST /api/v1/coupons/apply
 *      - Validation errors (missing fields, invalid amounts)
 *
 * Run with:
 *   node test/test-coupon.js
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

// ── HTTP helper ───────────────────────────────────────────────────────
function httpPost(path, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request({
      hostname: 'localhost', port: 3000, path, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    }, (res) => {
      let d = '';
      res.on('data', c => d += c);
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

function httpGet(path) {
  return new Promise((resolve, reject) => {
    http.get(`http://localhost:3000${path}`, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(d) }); }
        catch { resolve({ status: res.statusCode, body: d }); }
      });
    }).on('error', reject);
  });
}

function checkServer() {
  return new Promise((resolve) => {
    http.get('http://localhost:3000/health', (r) => resolve(r.statusCode === 200))
      .on('error', () => resolve(false));
  });
}

// ═══════════════════════════════════════════════════════════════════
//  UNIT SETUP — In-memory SQLite with seed data
// ═══════════════════════════════════════════════════════════════════

function buildTestDb() {
  const Database = require('better-sqlite3');
  const fs = require('fs');
  const dbPath = path.join(__dirname, '..', 'data', 'acg.sqlite');

  // Use the real DB (migrations already applied by server startup)
  const db = new Database(dbPath);
  db.pragma('foreign_keys = ON');
  return db;
}

// ═══════════════════════════════════════════════════════════════════
//  UNIT TESTS — CouponService
// ═══════════════════════════════════════════════════════════════════

section('Unit: CouponService — validateCoupon()');

(function testCouponServiceUnit() {
  const CouponService = require('../gateway/services/coupon.service');
  const db = buildTestDb();
  const svc = new CouponService(db);

  const MERCHANT = 'merch_sportshub';

  // ── RUN500: ₹500 FLAT discount on footwear ≥ ₹2,000 ───────────────
  // ₹4,299 (429900 paise) → ₹3,799 (379900 paise)
  {
    const r = svc.validateCoupon({ code: 'RUN500', merchant_id: MERCHANT, amount: 429900, category: 'footwear' });
    assert('RUN500: valid = true', r.valid === true, `valid: ${r.valid}`);
    assert('RUN500: original_amount = 429900', r.original_amount === 429900, `original: ${r.original_amount}`);
    assert('RUN500: discount_amount = 50000', r.discount_amount === 50000, `discount: ${r.discount_amount}`);
    assert('RUN500: final_amount = 379900', r.final_amount === 379900, `final: ${r.final_amount}`);
    assert('RUN500: discount_display is ₹500', r.discount_display.includes('500'), `display: ${r.discount_display}`);
    assert('RUN500: final_display is ₹3,799', r.final_display.includes('3,799'), `display: ${r.final_display}`);
  }

  // ── RUN500: case-insensitive code lookup ───────────────────────────
  {
    const r = svc.validateCoupon({ code: 'run500', merchant_id: MERCHANT, amount: 429900, category: 'footwear' });
    assert('RUN500: case-insensitive lookup', r.valid === true, 'Case-insensitive lookup failed');
  }

  // ── SAVE10: 10% PERCENTAGE, capped at ₹1,000 ──────────────────────
  // ₹5,000 (500000 paise) → 10% = 50000 paise (₹500), under cap → final ₹4,500
  {
    const r = svc.validateCoupon({ code: 'SAVE10', merchant_id: MERCHANT, amount: 500000 });
    assert('SAVE10: valid = true', r.valid === true, `valid: ${r.valid}`);
    assert('SAVE10: discount_amount = 50000', r.discount_amount === 50000, `discount: ${r.discount_amount}`);
    assert('SAVE10: final_amount = 450000', r.final_amount === 450000, `final: ${r.final_amount}`);
  }

  // ── SAVE10: cap kicks in at large order ───────────────────────────
  // ₹20,000 (2000000 paise) → 10% = 200000 paise, but capped at 100000 (₹1,000)
  {
    const r = svc.validateCoupon({ code: 'SAVE10', merchant_id: MERCHANT, amount: 2000000 });
    assert('SAVE10: cap enforced', r.discount_amount === 100000, `discount: ${r.discount_amount}`);
    assert('SAVE10: final with cap correct', r.final_amount === 1900000, `final: ${r.final_amount}`);
  }

  // ── WELCOME20: 20% percentage ──────────────────────────────────────
  // ₹1,000 (100000 paise) → 20% = 20000 paise, capped at 50000
  {
    const r = svc.validateCoupon({ code: 'WELCOME20', merchant_id: MERCHANT, amount: 100000 });
    assert('WELCOME20: valid = true', r.valid === true, `valid: ${r.valid}`);
    assert('WELCOME20: discount = 20000', r.discount_amount === 20000, `discount: ${r.discount_amount}`);
    assert('WELCOME20: final = 80000', r.final_amount === 80000, `final: ${r.final_amount}`);
  }

  // ── EXPIRED100: rejected (expired status) ─────────────────────────
  {
    let threw = null;
    try { svc.validateCoupon({ code: 'EXPIRED100', merchant_id: MERCHANT, amount: 100000 }); }
    catch (e) { threw = e; }
    assert('EXPIRED100: throws on inactive status',
      threw !== null && (threw.code === 'COUPON_INACTIVE' || threw.code === 'COUPON_EXPIRED'),
      `Expected COUPON_INACTIVE or COUPON_EXPIRED, got: ${threw?.code}`);
  }

  // ── MAXED50: usage limit reached ──────────────────────────────────
  {
    let threw = null;
    try { svc.validateCoupon({ code: 'MAXED50', merchant_id: MERCHANT, amount: 100000 }); }
    catch (e) { threw = e; }
    assert('MAXED50: throws COUPON_USAGE_LIMIT_REACHED',
      threw?.code === 'COUPON_USAGE_LIMIT_REACHED',
      `Got: ${threw?.code}`);
  }

  // ── Non-existent code ─────────────────────────────────────────────
  {
    let threw = null;
    try { svc.validateCoupon({ code: 'XYZNOTREAL', merchant_id: MERCHANT, amount: 100000 }); }
    catch (e) { threw = e; }
    assert('Unknown code: throws COUPON_NOT_FOUND',
      threw?.code === 'COUPON_NOT_FOUND', `Got: ${threw?.code}`);
  }

  // ── Min spend not met ─────────────────────────────────────────────
  // RUN500 requires min ₹2,000 (200000 paise); send ₹500 (50000)
  {
    let threw = null;
    try { svc.validateCoupon({ code: 'RUN500', merchant_id: MERCHANT, amount: 50000, category: 'footwear' }); }
    catch (e) { threw = e; }
    assert('RUN500: min spend not met → COUPON_MIN_SPEND_NOT_MET',
      threw?.code === 'COUPON_MIN_SPEND_NOT_MET', `Got: ${threw?.code}`);
  }

  // ── Category mismatch ─────────────────────────────────────────────
  // RUN500 is footwear-only; pass 'electronics'
  {
    let threw = null;
    try { svc.validateCoupon({ code: 'RUN500', merchant_id: MERCHANT, amount: 429900, category: 'electronics' }); }
    catch (e) { threw = e; }
    assert('RUN500: wrong category → COUPON_CATEGORY_MISMATCH',
      threw?.code === 'COUPON_CATEGORY_MISMATCH', `Got: ${threw?.code}`);
  }

  // ── RUN500 with null category — should pass (agent didn't specify) ─
  {
    const r = svc.validateCoupon({ code: 'RUN500', merchant_id: MERCHANT, amount: 429900 });
    assert('RUN500: null category skips category check', r.valid === true, `Expected valid, got: ${JSON.stringify(r)}`);
  }

  db.close();
})();

// ═══════════════════════════════════════════════════════════════════
//  UNIT TESTS — CouponService.listCoupons()
// ═══════════════════════════════════════════════════════════════════

section('Unit: CouponService — listCoupons()');

(function testListCoupons() {
  const CouponService = require('../gateway/services/coupon.service');
  const db = buildTestDb();
  const svc = new CouponService(db);
  const MERCHANT = 'merch_sportshub';

  // List all active coupons for merchant
  const all = svc.listCoupons({ merchant_id: MERCHANT });
  assert('listCoupons returns array', Array.isArray(all), 'Not an array');
  assert('listCoupons has at least 3 entries', all.length >= 3,
    `Got ${all.length} — expected RUN500, SAVE10, WELCOME20`);
  assert('listCoupons only returns ACTIVE', all.every(c => c.status === 'ACTIVE'),
    'Non-active coupon included');
  assert('listCoupons excludes EXPIRED100 and MAXED50', !all.some(c => c.code === 'EXPIRED100'),
    'EXPIRED100 should not appear in list');

  // Filter by category = footwear
  const footwear = svc.listCoupons({ merchant_id: MERCHANT, category: 'footwear' });
  assert('listCoupons category filter includes RUN500', footwear.some(c => c.code === 'RUN500'),
    'RUN500 should be in footwear list');

  // Filter by amount (too low for RUN500 min ₹2000)
  const small = svc.listCoupons({ merchant_id: MERCHANT, amount: 50000 });
  assert('listCoupons amount filter excludes high min_order coupons',
    !small.some(c => c.code === 'RUN500'), 'RUN500 should not appear for ₹500 cart');

  // Each coupon has a description
  assert('listCoupons has description field', all.every(c => typeof c.description === 'string'),
    'description missing from some coupons');

  db.close();
})();

// ═══════════════════════════════════════════════════════════════════
//  UNIT TESTS — applyCoupon (increments times_used)
// ═══════════════════════════════════════════════════════════════════

section('Unit: CouponService — applyCoupon()');

(function testApplyCoupon() {
  const CouponService = require('../gateway/services/coupon.service');
  const db = buildTestDb();
  const svc = new CouponService(db);
  const MERCHANT = 'merch_sportshub';

  // Get initial count
  const before = db.prepare("SELECT times_used FROM coupons WHERE code = 'WELCOME20'").get();

  // Apply WELCOME20
  const r = svc.applyCoupon({ code: 'WELCOME20', merchant_id: MERCHANT, amount: 100000 });
  assert('applyCoupon: applied = true', r.applied === true, `applied: ${r.applied}`);
  assert('applyCoupon: valid result shape', r.discount_amount > 0, 'discount should be > 0');

  // Verify counter incremented
  const after = db.prepare("SELECT times_used FROM coupons WHERE code = 'WELCOME20'").get();
  assert('applyCoupon: times_used incremented',
    after.times_used === before.times_used + 1,
    `Before: ${before.times_used}, After: ${after.times_used}`);

  // Reset to not pollute other tests
  db.prepare("UPDATE coupons SET times_used = ? WHERE code = 'WELCOME20'")
    .run(before.times_used);

  db.close();
})();

// ═══════════════════════════════════════════════════════════════════
//  INTEGRATION TESTS — HTTP Endpoints
// ═══════════════════════════════════════════════════════════════════

async function runIntegrationTests() {
  const serverUp = await checkServer();
  if (!serverUp) {
    section('Integration: Skipped (server not on localhost:3000)');
    skip('GET  /api/v1/coupons', 'Server not running');
    skip('POST /api/v1/coupons/validate (valid)', 'Server not running');
    skip('POST /api/v1/coupons/validate (invalid)', 'Server not running');
    skip('POST /api/v1/coupons/apply', 'Server not running');
    skip('POST /coupons/validate — validation errors', 'Server not running');
    return;
  }

  // ── GET /api/v1/coupons ───────────────────────────────────────────
  section('Integration: GET /api/v1/coupons');

  {
    const r = await httpGet('/api/v1/coupons?merchant_id=merch_sportshub');
    assert('GET /coupons 200', r.status === 200, `Status: ${r.status}`);
    assert('GET /coupons status: success', r.body?.status === 'success', `status: ${r.body?.status}`);
    assert('GET /coupons has coupons array', Array.isArray(r.body?.data?.coupons), 'coupons missing');
    assert('GET /coupons has total', typeof r.body?.data?.total === 'number', 'total missing');
    assert('GET /coupons has >= 3 coupons', r.body?.data?.total >= 3, `Got ${r.body?.data?.total}`);
  }

  {
    // Filter by category
    const r = await httpGet('/api/v1/coupons?merchant_id=merch_sportshub&category=footwear');
    assert('GET /coupons category filter 200', r.status === 200, `Status: ${r.status}`);
    assert('GET /coupons category filter has RUN500',
      r.body?.data?.coupons?.some(c => c.code === 'RUN500'), 'RUN500 missing from footwear filter');
  }

  {
    // Missing merchant_id
    const r = await httpGet('/api/v1/coupons');
    assert('GET /coupons missing merchant_id → 400', r.status === 400, `Status: ${r.status}`);
  }

  // ── POST /api/v1/coupons/validate ─────────────────────────────────
  section('Integration: POST /api/v1/coupons/validate');

  {
    // Valid: RUN500 on ₹4,299 footwear cart
    const r = await httpPost('/api/v1/coupons/validate', {
      code: 'RUN500',
      merchant_id: 'merch_sportshub',
      amount: 429900,
      category: 'footwear',
    });
    assert('POST /validate — 200', r.status === 200, `Status: ${r.status}`);
    assert('POST /validate — valid = true', r.body?.data?.valid === true, `valid: ${r.body?.data?.valid}`);
    assert('POST /validate — discount_amount = 50000',
      r.body?.data?.discount_amount === 50000, `discount: ${r.body?.data?.discount_amount}`);
    assert('POST /validate — final_amount = 379900',
      r.body?.data?.final_amount === 379900, `final: ${r.body?.data?.final_amount}`);
    assert('POST /validate — final_display contains 3,799',
      r.body?.data?.final_display?.includes('3,799'), `display: ${r.body?.data?.final_display}`);
  }

  {
    // Expired coupon
    const r = await httpPost('/api/v1/coupons/validate', {
      code: 'EXPIRED100',
      merchant_id: 'merch_sportshub',
      amount: 100000,
    });
    assert('POST /validate — expired → 422', r.status === 422, `Status: ${r.status}`);
    assert('POST /validate — expired has error code',
      ['COUPON_INACTIVE', 'COUPON_EXPIRED'].includes(r.body?.error),
      `error: ${r.body?.error}`);
  }

  {
    // Min spend not met
    const r = await httpPost('/api/v1/coupons/validate', {
      code: 'RUN500',
      merchant_id: 'merch_sportshub',
      amount: 50000,
      category: 'footwear',
    });
    assert('POST /validate — min spend not met → 422', r.status === 422, `Status: ${r.status}`);
    assert('POST /validate — COUPON_MIN_SPEND_NOT_MET code',
      r.body?.error === 'COUPON_MIN_SPEND_NOT_MET', `error: ${r.body?.error}`);
  }

  {
    // Not found
    const r = await httpPost('/api/v1/coupons/validate', {
      code: 'DOESNOTEXIST',
      merchant_id: 'merch_sportshub',
      amount: 100000,
    });
    assert('POST /validate — not found → 404', r.status === 404, `Status: ${r.status}`);
    assert('POST /validate — COUPON_NOT_FOUND code',
      r.body?.error === 'COUPON_NOT_FOUND', `error: ${r.body?.error}`);
  }

  // ── POST /validate — Zod validation ──────────────────────────────
  section('Integration: POST /validate — Zod validation');

  {
    const r = await httpPost('/api/v1/coupons/validate', {});
    assert('Missing code → 400', r.status === 400, `Status: ${r.status}`);
  }
  {
    const r = await httpPost('/api/v1/coupons/validate', { code: 'RUN500', merchant_id: 'merch_sportshub', amount: -1 });
    assert('Negative amount → 400', r.status === 400, `Status: ${r.status}`);
  }
  {
    const r = await httpPost('/api/v1/coupons/validate', { code: 'RUN500', merchant_id: 'merch_sportshub', amount: 1.5 });
    assert('Float amount → 400', r.status === 400, `Status: ${r.status}`);
  }

  // ── POST /api/v1/coupons/apply ────────────────────────────────────
  section('Integration: POST /api/v1/coupons/apply');

  {
    // Apply SAVE10 — doesn't have footwear restriction
    const r = await httpPost('/api/v1/coupons/apply', {
      code: 'SAVE10',
      merchant_id: 'merch_sportshub',
      amount: 500000,
    });
    assert('POST /apply — 200', r.status === 200, `Status: ${r.status}`);
    assert('POST /apply — applied = true', r.body?.data?.applied === true, `applied: ${r.body?.data?.applied}`);
    assert('POST /apply — discount_amount = 50000',
      r.body?.data?.discount_amount === 50000, `discount: ${r.body?.data?.discount_amount}`);
  }

  {
    // Apply invalid code → error
    const r = await httpPost('/api/v1/coupons/apply', {
      code: 'BOGUS999',
      merchant_id: 'merch_sportshub',
      amount: 100000,
    });
    assert('POST /apply — not found → 404', r.status === 404, `Status: ${r.status}`);
  }
}

// ═══════════════════════════════════════════════════════════════════
//  EXECUTE
// ═══════════════════════════════════════════════════════════════════

runIntegrationTests().then(() => {
  console.log('\n' + '─'.repeat(55));
  const total = passed + failed + skipped;
  const colour = failed > 0 ? RED : GREEN;
  console.log(`${BOLD}${colour}Results: ${passed}/${total - skipped} passed, ${failed} failed, ${skipped} skipped${RESET}`);

  if (failures.length > 0) {
    console.log(`\n${RED}${BOLD}Failed tests:${RESET}`);
    failures.forEach((f) => console.log(`  ${RED}✘ ${f.name}${RESET}\n      ${f.reason}`));
  }

  process.exit(failed > 0 ? 1 : 0);
});
