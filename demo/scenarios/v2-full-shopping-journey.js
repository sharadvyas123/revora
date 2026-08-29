/**
 * @module demo/scenarios/v2-full-shopping-journey
 * @description Phase 15 — Complete v2 End-to-End Purchase Scenario
 *
 * Demonstrates the full ACG v2 capability surface in a single runnable script:
 *
 *   Step  1: Parse intent — "buy running shoes under 5000 rupees"
 *   Step  2: Create Intent Mandate (human spending authorization)
 *   Step  3: PRODUCT_DISCOVERY  — multi-source web + local catalog search
 *   Step  4: PRODUCT_RECOMMENDATION — AI-scored ranking (decide pipeline)
 *   Step  5: PRODUCT_COMPARISON — side-by-side matrix for top 2 candidates
 *   Step  6: COUPON_PROVIDED — list active coupons for the merchant
 *   Step  7: COUPON_VALIDATED — validate RUN500, compute exact discount
 *   Step  8: DISCOUNT_APPLIED — create cart with coupon applied
 *   Step  9: Human Approval Gate (simulated)
 *   Step 10: PURCHASE_CONFIRMATION — explicit voice confirmation gate
 *   Step 11: PAYMENT — execute Razorpay test-mode payment
 *   Step 12: Verify + print full audit trail
 *
 * Usage:
 *   node demo/scenarios/v2-full-shopping-journey.js
 *
 * Prerequisites:
 *   npm run reset-db && npm run dev
 */

'use strict';

require('dotenv').config();

const BASE_URL  = process.env.GATEWAY_URL || 'http://localhost:3000';
const AGENT_ID  = 'agent_shopper_01';
const USER_ID   = 'user_jane_doe';
const MERCHANT  = 'merch_sportshub';
const COUPON    = 'RUN500';
const BUDGET_PAISE = 500000; // ₹5,000

// ── ANSI helpers ─────────────────────────────────────────────────────

const c = {
  reset:   '\x1b[0m',
  bold:    '\x1b[1m',
  dim:     '\x1b[2m',
  green:   '\x1b[32m',
  yellow:  '\x1b[33m',
  cyan:    '\x1b[36m',
  magenta: '\x1b[35m',
  red:     '\x1b[31m',
  white:   '\x1b[97m',
  bgBlue:  '\x1b[44m',
  bgGreen: '\x1b[42m',
  bgRed:   '\x1b[41m',
};

function header(text) {
  console.log(`\n${c.bgBlue}${c.white}${c.bold}  ${text}  ${c.reset}\n`);
}
function step(num, label) {
  console.log(`\n  ${c.cyan}${c.bold}► STEP ${String(num).padStart(2, '0')}${c.reset}  ${c.bold}${label}${c.reset}`);
}
function ok(text)   { console.log(`  ${c.green}✓${c.reset} ${text}`); }
function info(text) { console.log(`  ${c.dim}${text}${c.reset}`); }
function warn(text) { console.log(`  ${c.yellow}⚠${c.reset} ${text}`); }
function fail(text) { console.log(`  ${c.red}✗${c.reset} ${text}`); }

// ── HTTP helpers ──────────────────────────────────────────────────────

async function post(path, body, extraHeaders = {}) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method:  'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-agent-id':   AGENT_ID,
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (json.status !== 'success') {
    throw new Error(`POST ${path} failed [${res.status}]: ${json.message || JSON.stringify(json)}`);
  }
  return json.data;
}

async function get(path) {
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: { 'x-agent-id': AGENT_ID },
  });
  const json = await res.json();
  if (json.status !== 'success') {
    throw new Error(`GET ${path} failed [${res.status}]: ${json.message || JSON.stringify(json)}`);
  }
  return json.data;
}

// ── Audit logger (direct gateway HTTP call) ───────────────────────────
// We call the audit endpoint via the gateway to keep the demo self-contained.
// NOTE: The real demo records audit events through the service inside each
// gateway call — we also log select v2 steps explicitly here for the trail.

const auditLog = [];
function trackStep(step, data) {
  auditLog.push({ step, data, recorded_at: new Date().toISOString() });
}

// ─────────────────────────────────────────────────────────────────────
// MAIN SCENARIO
// ─────────────────────────────────────────────────────────────────────

async function runV2ShoppingJourney() {
  const startTime = Date.now();

  header('🚀 ACG v2 — Full Shopping Journey Scenario');
  console.log(`  ${c.bold}Prompt:${c.reset}  "buy running shoes under 5000 rupees"`);
  console.log(`  ${c.bold}Agent:${c.reset}   ${AGENT_ID}`);
  console.log(`  ${c.bold}User:${c.reset}    ${USER_ID}`);
  console.log(`  ${c.bold}Budget:${c.reset}  ₹${(BUDGET_PAISE / 100).toLocaleString('en-IN')}`);

  // ── Step 1: Create Intent Mandate ────────────────────────────────
  step(1, 'Create Intent Mandate (human spending authorization)');
  const intentMandate = await post('/api/v1/mandates/intent', {
    delegator_id: USER_ID,
    agent_id:     AGENT_ID,
    constraints: {
      max_amount:          BUDGET_PAISE,
      currency:            'INR',
      allowed_categories:  ['footwear'],
      single_use:          true,
    },
    ttl: 3600,
  });

  const auditTrailId = intentMandate.mandate_id;
  ok(`Intent Mandate: ${intentMandate.mandate_id}`);
  ok(`Status:         ${intentMandate.status}`);
  ok(`Budget cap:     ₹${(BUDGET_PAISE / 100).toLocaleString('en-IN')}`);
  trackStep('REQUEST', { agent_id: AGENT_ID, query: 'buy running shoes under 5000 rupees', mandate_id: auditTrailId });

  // ── Step 2: PRODUCT_DISCOVERY ─────────────────────────────────────
  step(2, 'Multi-Source Product Discovery (local + external web)');
  const discovery = await get(`/api/v1/discovery/search?q=running+shoes&max_price=${BUDGET_PAISE}&category=footwear&limit=10`);
  ok(`Sources queried:  ${(discovery.sources_queried || []).join(', ')}`);
  ok(`Total found:      ${discovery.total_found} products`);
  for (const r of (discovery.results || []).slice(0, 3)) {
    info(`  → [${r.match_source}] ${r.product.name} | ${r.product.price.display} | score: ${(r.relevance_score * 100).toFixed(0)}%`);
  }
  trackStep('PRODUCT_DISCOVERY', {
    agent_id:        AGENT_ID,
    query:           'running shoes',
    sources_queried: discovery.sources_queried,
    total_found:     discovery.total_found,
    top_results:     (discovery.results || []).slice(0, 3).map((r) => ({ name: r.product.name, price: r.product.price.display })),
  });

  // ── Step 3: PRODUCT_RECOMMENDATION ───────────────────────────────
  step(3, 'AI Recommendation Engine (score, rank, explain)');
  const recommendation = await post('/api/v1/recommendations/decide', {
    q:          'running shoes',
    max_price:  BUDGET_PAISE,
    category:   'footwear',
    limit:      8,
    local_only: false,
  });

  const recommendedId = recommendation.decision?.selected?.product_id || recommendation.decision?.recommended_product_id || null;
  const topCandidates = recommendation.comparison?.candidates || [];
  ok(`Recommended:  ${recommendation.decision?.selected?.name || recommendedId || 'N/A'}`);
  ok(`Reason:       ${(recommendation.decision?.selected?.reason || recommendation.decision?.recommendation_reason || 'N/A').substring(0, 80)}`);
  ok(`Candidates:   ${topCandidates.length} evaluated`);
  trackStep('PRODUCT_RECOMMENDATION', {
    agent_id:                AGENT_ID,
    query:                   'running shoes',
    recommended_product_id:  recommendedId,
    recommendation_reason:   recommendation.decision?.selected?.reason || '',
    candidates_evaluated:    topCandidates.length,
  });

  // ── Step 4: PRODUCT_COMPARISON ────────────────────────────────────
  step(4, 'Side-by-Side Product Comparison Matrix');
  const top2Ids = topCandidates.slice(0, 2).map((c) => c.product_id).filter(Boolean);

  let comparison = null;
  if (top2Ids.length >= 2) {
    comparison = await post('/api/v1/recommendations/compare', {
      product_ids: top2Ids,
      intent: { max_price: BUDGET_PAISE, category: 'footwear' },
    });
    ok(`Comparison ID:  ${comparison.comparison_id}`);
    ok(`Winner:         ${comparison.recommended_product_id || 'N/A'}`);
    for (const cand of (comparison.candidates || []).slice(0, 2)) {
      info(`  → ${cand.name} | ${cand.price_display} | score: ${cand.score} | badge: ${cand.badge || '—'}`);
    }
    trackStep('PRODUCT_COMPARISON', {
      agent_id:          AGENT_ID,
      comparison_id:     comparison.comparison_id,
      product_ids:       top2Ids,
      winner_product_id: comparison.recommended_product_id,
    });
  } else {
    warn('Less than 2 products found — skipping comparison matrix.');
  }

  // ── Step 5: COUPON_PROVIDED ───────────────────────────────────────
  step(5, 'Discover Available Coupons');
  const couponList = await get(`/api/v1/coupons?merchant_id=${MERCHANT}&category=footwear&amount=${BUDGET_PAISE}`);
  ok(`Merchant:    ${couponList.merchant_id}`);
  ok(`Coupons:     ${couponList.total} available`);
  for (const cp of couponList.coupons) {
    info(`  → [${cp.discount_type}] ${cp.code}: ${cp.discount_type === 'FLAT' ? `₹${(cp.discount_value / 100).toLocaleString('en-IN')} off` : `${cp.discount_value}% off`} | min ₹${(cp.min_order_amount / 100).toLocaleString('en-IN')}`);
  }
  trackStep('COUPON_PROVIDED', {
    agent_id:     AGENT_ID,
    merchant_id:  MERCHANT,
    coupons_found: couponList.total,
    coupon_codes: couponList.coupons.map((cp) => cp.code),
  });

  // Pick a product to buy — use recommended or first candidate
  const selectedProductId = recommendedId
    || (topCandidates[0] && topCandidates[0].product_id)
    || 'prod_nike_pegasus';

  // Use price from recommended candidate (fallback ₹2,799)
  const selectedCandidate = topCandidates.find((c) => c.product_id === selectedProductId) || topCandidates[0];
  const originalAmount = selectedCandidate?.price || 279900;

  // ── Step 6: COUPON_VALIDATED ──────────────────────────────────────
  step(6, `Validate Coupon "${COUPON}" (compute exact discount)`);
  let couponResult = null;
  try {
    const res = await fetch(`${BASE_URL}/api/v1/coupons/validate`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        code:        COUPON,
        merchant_id: MERCHANT,
        amount:      originalAmount,
        category:    'footwear',
      }),
    });
    const json = await res.json();
    if (json.status === 'success') {
      couponResult = json.data;
      ok(`Valid:           ${couponResult.valid}`);
      ok(`Original amount: ${couponResult.original_display}`);
      ok(`Discount:        ${couponResult.discount_display}`);
      ok(`Final amount:    ${couponResult.final_display}`);
    } else {
      warn(`Coupon validation returned error: ${json.message} — proceeding without coupon`);
    }
  } catch (e) {
    warn(`Coupon validation failed: ${e.message} — proceeding without coupon`);
  }
  trackStep('COUPON_VALIDATED', {
    agent_id:        AGENT_ID,
    coupon_code:     COUPON,
    merchant_id:     MERCHANT,
    original_amount: originalAmount,
    discount_amount: couponResult?.discount_amount ?? 0,
    final_amount:    couponResult?.final_amount ?? originalAmount,
    valid:           couponResult?.valid ?? false,
  });

  // ── Step 7: DISCOUNT_APPLIED — Create Cart with Coupon ───────────
  step(7, 'Create Cart Mandate (with coupon applied)');
  const cartPayload = {
    intent_mandate_id: intentMandate.mandate_id,
    agent_id:          AGENT_ID,
    items: [{ product_id: selectedProductId, quantity: 1 }],
    reasoning: {
      query:  'buy running shoes under 5000 rupees',
      reason: 'Best rated running shoe within budget — selected after multi-source discovery and AI recommendation pipeline.',
      alternatives: [],
    },
  };

  // Attach coupon if validation passed
  if (couponResult?.valid) {
    cartPayload.coupon_code = COUPON;
    cartPayload.merchant_id_for_coupon = MERCHANT;
  }

  const cart = await post('/api/v1/mandates/cart', cartPayload);
  ok(`Cart Mandate:   ${cart.mandate_id}`);
  ok(`Status:         ${cart.status}`);
  ok(`Total:          ${cart.cart?.total_display || 'N/A'}`);
  if (couponResult?.valid) {
    ok(`Coupon applied: ${COUPON} — saved ${couponResult.discount_display}`);
  }
  trackStep('DISCOUNT_APPLIED', {
    agent_id:        AGENT_ID,
    cart_mandate_id: cart.mandate_id,
    coupon_code:     couponResult?.valid ? COUPON : null,
    original_amount: originalAmount,
    discount_amount: couponResult?.discount_amount ?? 0,
    final_amount:    cart.cart?.total_amount ?? originalAmount,
  });

  // ── Step 8: Human Approval Gate ───────────────────────────────────
  step(8, 'Human Approval Gate (simulated)');
  info('  [Simulating human delegator approval...]');
  const approval = await post(`/api/v1/mandates/cart/${cart.mandate_id}/approve`, {
    approved_by: USER_ID,
  });
  ok(`Payment Mandate: ${approval.mandate_id}`);
  ok(`Status:          ${approval.status}`);
  trackStep('APPROVAL', {
    cart_mandate_id:    cart.mandate_id,
    payment_mandate_id: approval.mandate_id,
    decision:           'APPROVED',
    delegator_id:       USER_ID,
  });

  // ── Step 9: PURCHASE_CONFIRMATION — Explicit Voice Gate ───────────
  step(9, 'Explicit Purchase Confirmation Gate (VOICE channel)');
  info('  [Simulating user voice confirmation: "yes, proceed with purchase"]');
  const confirmation = await post('/api/v1/mandates/cart/confirm', {
    cart_mandate_id:     cart.mandate_id,
    user_confirmation:   true,
    channel:             'VOICE',
    confirmation_phrase: 'yes, proceed with purchase',
  });
  ok(`Confirmation status: ${confirmation.confirmation_status}`);
  ok(`Ready for payment:   ${confirmation.ready_for_payment}`);
  ok(`Confirmed at:        ${confirmation.confirmed_at}`);
  trackStep('PURCHASE_CONFIRMATION', {
    agent_id:             AGENT_ID,
    cart_mandate_id:      cart.mandate_id,
    user_confirmation:    true,
    channel:              'VOICE',
    confirmation_phrase:  'yes, proceed with purchase',
  });

  // ── Step 10: PAYMENT — Execute Payment ────────────────────────────
  step(10, 'Execute Payment (Razorpay test-mode)');
  const payment = await post('/api/v1/payments/execute', {
    payment_mandate_id: approval.mandate_id,
    agent_id:           AGENT_ID,
  });
  ok(`Transaction:    ${payment.transaction_id}`);
  ok(`Status:         ${payment.status}`);
  ok(`Razorpay Order: ${payment.razorpay?.order_id}`);
  ok(`Razorpay Pmnt:  ${payment.razorpay?.payment_id}`);
  ok(`Total:          ${payment.order?.total_display}`);
  trackStep('PAYMENT', {
    transaction_id:      payment.transaction_id,
    razorpay_order_id:   payment.razorpay?.order_id,
    razorpay_payment_id: payment.razorpay?.payment_id,
    amount:              payment.order?.total_amount,
    status:              payment.status,
  });

  // ── Step 11: Verify + Audit Trail ─────────────────────────────────
  step(11, 'Verify Transaction & Print Audit Trail');
  const verification = await get(`/api/v1/payments/${payment.transaction_id}`);
  ok(`Verified Status: ${verification.status}`);
  ok(`Completed At:    ${verification.completed_at}`);
  ok(`Audit Trail ID:  ${verification.audit_trail_id}`);

  // Fetch the full audit trail from the gateway
  let gatewayTrail = null;
  try {
    const trailData = await get(`/api/v1/audit/transactions/${payment.transaction_id}`);
    gatewayTrail = trailData;
  } catch (_) { /* non-critical */ }

  // ── Final Summary ─────────────────────────────────────────────────
  const totalDuration = Date.now() - startTime;
  console.log(`\n${c.bgGreen}${c.white}${c.bold}  ✅ V2 PURCHASE COMPLETE  ${c.reset}\n`);

  console.log(`  ${c.bold}═══════════════════════════════════════════════════${c.reset}`);
  console.log(`  ${c.bold}  Scenario Summary${c.reset}`);
  console.log(`  ${c.bold}═══════════════════════════════════════════════════${c.reset}`);
  console.log(`  Prompt:              "buy running shoes under 5000 rupees"`);
  console.log(`  Agent:               ${AGENT_ID}`);
  console.log(`  Transaction ID:      ${payment.transaction_id}`);
  console.log(`  Status:              ${verification.status}`);
  console.log(`  Product Purchased:   ${selectedProductId}`);
  console.log(`  Coupon Applied:      ${couponResult?.valid ? `${COUPON} (saved ${couponResult.discount_display})` : 'None'}`);
  console.log(`  Total Paid:          ${payment.order?.total_display}`);
  console.log(`  Audit Trail ID:      ${verification.audit_trail_id}`);
  console.log(`  Total Duration:      ${totalDuration}ms`);

  console.log(`\n  ${c.bold}In-Script Audit Steps Recorded (${auditLog.length}):${c.reset}`);
  for (let i = 0; i < auditLog.length; i++) {
    const entry = auditLog[i];
    console.log(`  ${c.dim}${String(i + 1).padStart(2, ' ')}.${c.reset} ${c.cyan}${entry.step.padEnd(24)}${c.reset} ${c.dim}@ ${entry.recorded_at}${c.reset}`);
  }

  if (gatewayTrail && gatewayTrail.timeline) {
    console.log(`\n  ${c.bold}Gateway Audit Trail (${gatewayTrail.total_entries} entries):${c.reset}`);
    for (const entry of gatewayTrail.timeline) {
      console.log(`  ${c.dim}•${c.reset} ${c.magenta}${entry.step.padEnd(24)}${c.reset} ${c.dim}${entry.timestamp}${c.reset}`);
    }
  }

  console.log('');

  return {
    success: true,
    transaction_id:    payment.transaction_id,
    status:            verification.status,
    total_amount:      payment.order?.total_amount,
    audit_trail_id:    verification.audit_trail_id,
    audit_steps:       auditLog.map((e) => e.step),
    total_duration_ms: totalDuration,
  };
}

// ── Entry Point ───────────────────────────────────────────────────────

if (require.main === module) {
  runV2ShoppingJourney().catch((err) => {
    fail(`Fatal error: ${err.message}`);
    console.error(err.stack);
    process.exit(1);
  });
}

module.exports = runV2ShoppingJourney;
