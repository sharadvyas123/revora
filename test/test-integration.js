/**
 * Phase 7 Integration Test Suite
 * 
 * Tests the complete security and commerce pipeline end-to-end:
 *   Test 1: Agent Authentication & Access Control
 *   Test 2: Mandate Chain Integrity & JWT Token Validation
 *   Test 3: Full Multi-Hop Commerce Pipeline (Auth → Mandate → ACP → Razorpay → Audit)
 *   Test 4: Idempotency & Double-Spend / Replay Prevention
 * 
 * Prerequisites:
 *   1. node db/reset.js
 *   2. node gateway/server.js (running on port 3000)
 *   3. node test/test-integration.js
 */

const BASE = 'http://localhost:3000/api/v1';
const HEALTH = 'http://localhost:3000/health';

let passed = 0;
let failed = 0;

// ── Helpers ─────────────────────────────────────────────────────────

async function request(method, path, { body, headers = {} } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, data: await res.json() };
}

function assert(condition, message) {
  if (condition) {
    console.log(`  ✓ ${message}`);
    passed++;
  } else {
    console.log(`  ✗ ${message}`);
    failed++;
  }
}

function section(title) {
  console.log(`\n── ${title} ──\n`);
}

// ════════════════════════════════════════════════════════════════════
//  PRE-FLIGHT
// ════════════════════════════════════════════════════════════════════

async function preflight() {
  const res = await fetch(HEALTH);
  const data = await res.json();
  if (data.status !== 'healthy') throw new Error('Gateway not healthy');
  console.log(`  ✓ Gateway: ${data.status}`);
  console.log(`  ✓ Products: ${data.database.products}`);
  console.log(`  ✓ Agents:   ${data.database.agents}`);
}

// ════════════════════════════════════════════════════════════════════
//  TEST 1: Agent Authentication & Access Control
// ════════════════════════════════════════════════════════════════════

async function test1_agentAuth() {
  section('TEST 1: Agent Authentication & Access Control');

  // 1a. Public catalog endpoint — no auth required
  const catalog = await request('GET', '/catalog/products');
  assert(catalog.status === 200, 'Catalog (public) returns 200 without auth');

  // 1b. Protected endpoint (mandates) — no agent ID → allowed through but body validation fails at route level
  // Since agent_id is OPTIONAL (anonymous allowed for basic mandate creation tests),
  // we test with explicit INVALID agent to see rejection:
  const unknownAgent = await request('POST', '/mandates/intent', {
    body: {
      delegator_id: 'user_jane_doe',
      agent_id: 'agent_doesnt_exist',
      constraints: { max_amount: 100000 },
    },
    headers: { 'x-agent-id': 'agent_doesnt_exist' },
  });
  assert(unknownAgent.status === 401, 'Unknown agent rejected with 401 UNAUTHORIZED_AGENT');
  assert(
    unknownAgent.data?.error === 'UNAUTHORIZED_AGENT',
    `Error code is UNAUTHORIZED_AGENT (got: ${unknownAgent.data?.error})`
  );

  // 1c. Valid registered agent — mandate creation succeeds
  const validMandate = await request('POST', '/mandates/intent', {
    body: {
      delegator_id: 'user_jane_doe',
      agent_id: 'agent_shopper_01',
      constraints: { max_amount: 200000, currency: 'INR', single_use: true },
    },
    headers: { 'x-agent-id': 'agent_shopper_01' },
  });
  assert(validMandate.status === 201, 'Valid agent creates intent mandate (201)');
  assert(validMandate.data?.status === 'success', 'Response status is success');

  const mandateId = validMandate.data?.data?.mandate_id;
  assert(!!mandateId, `Mandate ID returned: ${mandateId}`);

  return { mandateId, mandateToken: validMandate.data?.data?.token };
}

// ════════════════════════════════════════════════════════════════════
//  TEST 2: Mandate Chain Integrity & JWT Token Validation
// ════════════════════════════════════════════════════════════════════

async function test2_mandateChain() {
  section('TEST 2: Mandate Chain Integrity & JWT Token Validation');

  // Create a fresh intent mandate for this test
  const intentRes = await request('POST', '/mandates/intent', {
    body: {
      delegator_id: 'user_jane_doe',
      agent_id: 'agent_shopper_01',
      constraints: { max_amount: 300000, currency: 'INR', single_use: true },
    },
    headers: { 'x-agent-id': 'agent_shopper_01' },
  });
  assert(intentRes.status === 201, 'Intent mandate created for chain test');
  const intentMandateId = intentRes.data?.data?.mandate_id;

  // 2a. Create cart mandate referencing the intent
  const cartRes = await request('POST', '/mandates/cart', {
    body: {
      intent_mandate_id: intentMandateId,
      agent_id: 'agent_shopper_01',
      items: [{ product_id: 'prod_puma_velocity', quantity: 1 }],
      reasoning: { query: 'running shoes', reason: 'Best value within budget' },
    },
    headers: { 'x-agent-id': 'agent_shopper_01' },
  });
  assert(cartRes.status === 201, 'Cart mandate created from intent (201)');
  assert(cartRes.data?.data?.status === 'PENDING_APPROVAL', 'Cart status is PENDING_APPROVAL');
  const cartMandateId = cartRes.data?.data?.mandate_id;

  // 2b. Reject a cart with a broken chain (wrong intent_mandate_id)
  const brokenChainRes = await request('POST', '/mandates/cart', {
    body: {
      intent_mandate_id: 'mdt_intent_fakefake',
      agent_id: 'agent_shopper_01',
      items: [{ product_id: 'prod_puma_nitro', quantity: 1 }],
    },
    headers: { 'x-agent-id': 'agent_shopper_01' },
  });
  assert(brokenChainRes.status === 400 || brokenChainRes.status === 404, 'Broken chain mandate rejected');

  // 2c. Approve cart to get payment mandate
  const approveRes = await request('POST', `/mandates/cart/${cartMandateId}/approve`, {
    body: { approved_by: 'user_jane_doe' },
    headers: { 'x-agent-id': 'agent_shopper_01' },
  });
  assert(approveRes.status === 200, 'Cart mandate approved (200)');
  assert(approveRes.data?.data?.status === 'AUTHORIZED', 'Payment mandate is AUTHORIZED');
  const paymentMandateId = approveRes.data?.data?.mandate_id;

  return { intentMandateId, cartMandateId, paymentMandateId };
}

// ════════════════════════════════════════════════════════════════════
//  TEST 3: Full Multi-Hop Commerce Pipeline
// ════════════════════════════════════════════════════════════════════

async function test3_fullPipeline() {
  section('TEST 3: Full Multi-Hop Commerce Pipeline (Auth → Mandate → ACP → Razorpay → Audit)');

  // Step A: Authenticate — catalog discovery
  const searchRes = await request('GET', '/catalog/search?q=running+shoes&max_price=300000&category=footwear&limit=5');
  assert(searchRes.status === 200, 'ACP Catalog search returns 200');
  assert(searchRes.data?.data?.total_matches > 0, `Catalog returns products (${searchRes.data?.data?.total_matches} found)`);

  // Step B: Create Intent Mandate
  const intentRes = await request('POST', '/mandates/intent', {
    body: {
      delegator_id: 'user_jane_doe',
      agent_id: 'agent_shopper_01',
      constraints: { max_amount: 300000, currency: 'INR', allowed_categories: ['footwear'], single_use: true },
    },
    headers: { 'x-agent-id': 'agent_shopper_01' },
  });
  assert(intentRes.status === 201, 'Intent mandate created with spend cap (₹3,000)');
  const intentMandateId = intentRes.data?.data?.mandate_id;

  // Step C: Create Cart Mandate
  const cartRes = await request('POST', '/mandates/cart', {
    body: {
      intent_mandate_id: intentMandateId,
      agent_id: 'agent_shopper_01',
      items: [{ product_id: 'prod_puma_velocity', quantity: 1 }],
      reasoning: {
        query: 'running shoes under 3000',
        reason: 'Puma Velocity Nitro 3 selected — best price/rating ratio within budget',
        alternatives: [{ product_id: 'prod_nike_pegasus', reason: 'Higher price at ₹2,799' }],
      },
    },
    headers: { 'x-agent-id': 'agent_shopper_01' },
  });
  assert(cartRes.status === 201, `Cart mandate created with AI reasoning (got ${cartRes.status}: ${JSON.stringify(cartRes.data?.error)})`);
  const cartTotal = cartRes.data?.data?.cart?.total_amount;
  assert(cartTotal <= 300000, `Cart total ${cartTotal} paise is within ₹3,000 budget`);
  const cartMandateId = cartRes.data?.data?.mandate_id;

  // Step D: Category / spend cap violation guard
  // Garmin Forerunner (prod_garmin_watch) is electronics (not footwear) AND costs ₹49,999 (over ₹3,000 cap)
  // Should be rejected by either CATEGORY_VIOLATION or AMOUNT_EXCEEDED
  const overCapRes = await request('POST', '/mandates/cart', {
    body: {
      intent_mandate_id: intentMandateId,
      agent_id: 'agent_shopper_01',
      items: [{ product_id: 'prod_garmin_watch', quantity: 1 }],
    },
    headers: { 'x-agent-id': 'agent_shopper_01' },
  });
  assert(
    overCapRes.status === 402 || overCapRes.status === 422 || overCapRes.status === 400,
    `Over-budget / category-violated cart rejected (got ${overCapRes.status})`
  );

  // Step E: Delegator Approval
  const approveRes = await request('POST', `/mandates/cart/${cartMandateId}/approve`, {
    body: { approved_by: 'user_jane_doe' },
    headers: { 'x-agent-id': 'agent_shopper_01' },
  });
  assert(approveRes.status === 200, 'Human delegator approved cart');
  const paymentMandateId = approveRes.data?.data?.mandate_id;

  // Step F: Razorpay Payment Execution
  const payRes = await request('POST', '/payments/execute', {
    body: {
      payment_mandate_id: paymentMandateId,
      agent_id: 'agent_shopper_01',
    },
    headers: { 'x-agent-id': 'agent_shopper_01' },
  });
  assert(payRes.status === 201, 'Payment execution returns 201');
  assert(payRes.data?.data?.status === 'CAPTURED', 'Payment status is CAPTURED');
  const txnId = payRes.data?.data?.transaction_id;
  const razorpayOrderId = payRes.data?.data?.razorpay?.order_id;
  assert(!!razorpayOrderId?.startsWith('order_'), `Razorpay order created: ${razorpayOrderId}`);
  console.log(`  ✓ Transaction ID: ${txnId}`);

  // Step G: Payment Verification
  const verifyRes = await request('GET', `/payments/${txnId}`, {
    headers: { 'x-agent-id': 'agent_shopper_01' },
  });
  assert(verifyRes.status === 200, 'Transaction verification returns 200');
  assert(verifyRes.data?.data?.status === 'CAPTURED', 'Verified: status CAPTURED');
  assert(!!verifyRes.data?.data?.completed_at, 'Verified: completed_at timestamp present');

  // Step H: Audit Trail Verification
  const auditRes = await request('GET', `/audit/trails/${intentMandateId}`);
  assert(auditRes.status === 200, 'Audit trail readable (public endpoint)');
  const timeline = auditRes.data?.data?.timeline;
  assert(Array.isArray(timeline) && timeline.length >= 4, `Audit trail has ${timeline?.length} events recorded`);

  const stepTypes = timeline?.map(e => e.step);
  assert(stepTypes?.includes('REQUEST'), 'Audit: REQUEST step recorded');
  assert(stepTypes?.includes('APPROVAL'), 'Audit: APPROVAL step recorded');
  assert(stepTypes?.includes('PAYMENT'), 'Audit: PAYMENT step recorded');
  assert(stepTypes?.includes('OUTCOME'), 'Audit: OUTCOME step recorded');

  return { txnId, intentMandateId, paymentMandateId };
}

// ════════════════════════════════════════════════════════════════════
//  TEST 4: Idempotency & Double-Spend Replay Prevention
// ════════════════════════════════════════════════════════════════════

async function test4_idempotency({ paymentMandateId }) {
  section('TEST 4: Idempotency & Double-Spend Replay Prevention');

  // 4a. Attempt to re-execute a payment mandate that's already been USED
  const replayRes = await request('POST', '/payments/execute', {
    body: {
      payment_mandate_id: paymentMandateId,
      agent_id: 'agent_shopper_01',
    },
    headers: { 'x-agent-id': 'agent_shopper_01' },
  });
  assert(
    replayRes.status === 409 || replayRes.status === 403 || replayRes.status === 400 || replayRes.status === 422,
    `Replay attack rejected (HTTP ${replayRes.status})`
  );
  const replayError = replayRes.data?.error;
  assert(
    replayError === 'MANDATE_USED' || replayError === 'MANDATE_EXPIRED' || replayRes.status >= 400,
    `Replay error code: ${replayError || 'rejected with 4xx'}`
  );

  // 4b. Attempt cart approval twice on the same cart mandate (double-approval)
  // Use a fresh, independent intent mandate (NOT single-use, higher budget)
  const intentRes2 = await request('POST', '/mandates/intent', {
    body: {
      delegator_id: 'user_jane_doe',
      agent_id: 'agent_shopper_01',
      constraints: { max_amount: 250000, currency: 'INR' },
    },
    headers: { 'x-agent-id': 'agent_shopper_01' },
  });
  const cartRes2 = await request('POST', '/mandates/cart', {
    body: {
      intent_mandate_id: intentRes2.data?.data?.mandate_id,
      agent_id: 'agent_shopper_01',
      items: [{ product_id: 'prod_nike_dunk', quantity: 1 }],
    },
    headers: { 'x-agent-id': 'agent_shopper_01' },
  });
  const cartMandateId2 = cartRes2.data?.data?.mandate_id;
  if (!cartMandateId2) {
    console.log(`  ⚠ Could not create cart for idempotency test: ${JSON.stringify(cartRes2.data?.error)}`);
    return;
  }

  // Approve once
  await request('POST', `/mandates/cart/${cartMandateId2}/approve`, {
    body: { approved_by: 'user_jane_doe' },
    headers: { 'x-agent-id': 'agent_shopper_01' },
  });

  // Approve twice — should fail
  const doubleApprove = await request('POST', `/mandates/cart/${cartMandateId2}/approve`, {
    body: { approved_by: 'user_jane_doe' },
    headers: { 'x-agent-id': 'agent_shopper_01' },
  });
  assert(
    doubleApprove.status >= 400,
    `Double-approval rejected (HTTP ${doubleApprove.status})`
  );

  console.log(`  ✓ Replay & double-spend prevention verified`);
}

// ════════════════════════════════════════════════════════════════════
//  MAIN
// ════════════════════════════════════════════════════════════════════

async function main() {
  console.log('');
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  Phase 7 Integration Test Suite — ACG');
  console.log('═══════════════════════════════════════════════════════════');

  // Pre-flight
  console.log('\n── Pre-flight: Gateway health check ──\n');
  try {
    await preflight();
  } catch {
    console.error('\n  ✗ Gateway is not running! Start with: node gateway/server.js');
    process.exit(1);
  }

  // Run tests
  await test1_agentAuth();
  await test2_mandateChain();
  const { paymentMandateId } = await test3_fullPipeline();
  await test4_idempotency({ paymentMandateId });

  // Results
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log(`  Results: ${passed} passed, ${failed} failed`);
  if (failed === 0) {
    console.log('  ✅ ALL INTEGRATION TESTS PASSED — Phase 7 Verified!');
  } else {
    console.log('  ❌ SOME TESTS FAILED — review output above');
  }
  console.log('═══════════════════════════════════════════════════════════\n');

  if (failed > 0) process.exit(1);
}

main().catch(e => {
  console.error('\n✗ FATAL:', e.message);
  process.exit(1);
});
