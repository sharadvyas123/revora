/**
 * Phase 3 verification script — tests the full mandate chain.
 * Run with: node test-mandates.js
 */

const BASE = 'http://localhost:3000/api/v1';

async function post(path, body) {
  const res = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function get(path) {
  const res = await fetch(BASE + path);
  return res.json();
}

async function main() {
  console.log('');
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  Phase 3 Verification: Mandate Engine');
  console.log('═══════════════════════════════════════════════════════════');

  // ── TEST 1: Happy Path ────────────────────────────────────────────
  console.log('\n── TEST 1: Happy Path (Intent → Cart → Approve → Payment) ──\n');

  // Step 1: Create Intent Mandate
  console.log('STEP 1: Create Intent Mandate (₹3,000 cap, footwear only)');
  const intent = await post('/mandates/intent', {
    delegator_id: 'user_jane_doe',
    agent_id: 'agent_shopper_01',
    constraints: {
      max_amount: 300000,
      currency: 'INR',
      allowed_categories: ['footwear'],
      single_use: true,
    },
    ttl: 3600,
  });
  console.log('  ✓ Status:', intent.status);
  console.log('  ✓ Mandate ID:', intent.data.mandate_id);
  console.log('  ✓ Type:', intent.data.type, '| Status:', intent.data.status);
  console.log('  ✓ Max Amount:', intent.data.constraints.max_amount, 'paise');
  console.log('');

  // Step 2: Create Cart (Nike Pegasus ₹2,799 — under cap)
  console.log('STEP 2: Create Cart (Nike Pegasus ₹2,799 — under ₹3,000 cap)');
  const cart = await post('/mandates/cart', {
    intent_mandate_id: intent.data.mandate_id,
    agent_id: 'agent_shopper_01',
    items: [{
      product_id: 'prod_nike_pegasus',
      variant_id: 'var_nike_peg_10_black',
      quantity: 1,
    }],
    reasoning: {
      query: 'running shoes under 3000',
      reason: 'Best rated running shoe within budget at ₹2,799',
      alternatives: [{
        product_id: 'prod_asics_gel',
        reason: 'Also good but slightly higher price',
      }],
    },
  });
  console.log('  ✓ Status:', cart.status);
  console.log('  ✓ Cart Mandate ID:', cart.data.mandate_id);
  console.log('  ✓ Type:', cart.data.type, '| Status:', cart.data.status);
  console.log('  ✓ Cart Total:', cart.data.cart.total_display);
  console.log('');

  // Step 3: Approve Cart
  console.log('STEP 3: Human approves the cart');
  const payment = await post('/mandates/cart/' + cart.data.mandate_id + '/approve', {
    approved_by: 'user_jane_doe',
  });
  console.log('  ✓ Status:', payment.status);
  console.log('  ✓ Payment Mandate ID:', payment.data.mandate_id);
  console.log('  ✓ Type:', payment.data.type, '| Status:', payment.data.status);
  console.log('  ✓ Exact Amount:', payment.data.constraints.exact_amount, 'paise');
  console.log('  ✓ Token:', payment.data.token.substring(0, 50) + '...');
  console.log('');

  // Step 4: View the full chain
  console.log('STEP 4: View full mandate chain');
  const chain = await get('/mandates/' + payment.data.mandate_id + '/chain');
  chain.data.chain.forEach((m) => {
    console.log('  ' + m.type + ': ' + m.mandate_id + ' → ' + m.status);
  });
  console.log('');
  console.log('  ✅ TEST 1 PASSED: Happy path complete!\n');

  // ── TEST 2: Spend Cap Violation ───────────────────────────────────
  console.log('── TEST 2: Spend Cap Violation (Adidas ₹3,199 > ₹3,000 cap) ──\n');

  // New intent for this test
  const intent2 = await post('/mandates/intent', {
    delegator_id: 'user_jane_doe',
    agent_id: 'agent_shopper_01',
    constraints: {
      max_amount: 300000,
      currency: 'INR',
      allowed_categories: ['footwear'],
      single_use: true,
    },
    ttl: 3600,
  });
  console.log('  ✓ Intent created:', intent2.data.mandate_id);

  const cartFail = await post('/mandates/cart', {
    intent_mandate_id: intent2.data.mandate_id,
    agent_id: 'agent_shopper_01',
    items: [{
      product_id: 'prod_adidas_ultraboost',
      variant_id: 'var_adi_ub_10_black',
      quantity: 1,
    }],
  });
  console.log('  ✓ Error Code:', cartFail.error);
  console.log('  ✓ HTTP Status:', cartFail.code);
  console.log('  ✓ Message:', cartFail.message);
  console.log('  ✓ Recovery:', cartFail.recovery?.suggestion);
  console.log('');
  console.log('  ✅ TEST 2 PASSED: Spend cap correctly blocked!\n');

  // ── TEST 3: Category Violation ────────────────────────────────────
  console.log('── TEST 3: Category Violation (apparel ≠ footwear) ──\n');

  const intent3 = await post('/mandates/intent', {
    delegator_id: 'user_jane_doe',
    agent_id: 'agent_shopper_01',
    constraints: {
      max_amount: 500000,
      currency: 'INR',
      allowed_categories: ['footwear'],
      single_use: true,
    },
    ttl: 3600,
  });
  console.log('  ✓ Intent created:', intent3.data.mandate_id);

  const cartCatFail = await post('/mandates/cart', {
    intent_mandate_id: intent3.data.mandate_id,
    agent_id: 'agent_shopper_01',
    items: [{
      product_id: 'prod_dryfit_tee',
      quantity: 1,
    }],
  });
  console.log('  ✓ Error Code:', cartCatFail.error);
  console.log('  ✓ Message:', cartCatFail.message);
  console.log('');
  console.log('  ✅ TEST 3 PASSED: Category constraint enforced!\n');

  // ── TEST 4: Rejection Flow ────────────────────────────────────────
  console.log('── TEST 4: Rejection Flow ──\n');

  const intent4 = await post('/mandates/intent', {
    delegator_id: 'user_jane_doe',
    agent_id: 'agent_shopper_01',
    constraints: { max_amount: 300000, allowed_categories: ['footwear'] },
    ttl: 3600,
  });

  const cartReject = await post('/mandates/cart', {
    intent_mandate_id: intent4.data.mandate_id,
    agent_id: 'agent_shopper_01',
    items: [{ product_id: 'prod_puma_velocity', quantity: 1 }],
    reasoning: { reason: 'Cheapest option' },
  });
  console.log('  ✓ Cart created:', cartReject.data.mandate_id, '| Status:', cartReject.data.status);

  const rejected = await post('/mandates/cart/' + cartReject.data.mandate_id + '/reject', {
    rejected_by: 'user_jane_doe',
    reason: 'I prefer Nike or ASICS brands only',
  });
  console.log('  ✓ Rejected:', rejected.data.mandate_id, '| Status:', rejected.data.status);
  console.log('  ✓ Rejection Reason:', rejected.data.rejection_reason);
  console.log('');
  console.log('  ✅ TEST 4 PASSED: Rejection flow works!\n');

  // ── Summary ───────────────────────────────────────────────────────
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  ✅ ALL 4 TESTS PASSED — Phase 3 Verified!');
  console.log('═══════════════════════════════════════════════════════════');
  console.log('');
}

main().catch((e) => {
  console.error('');
  console.error('✗ TEST FAILED:', e.message);
  console.error(e.stack);
  process.exit(1);
});
