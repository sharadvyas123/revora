/**
 * Phase 5 verification script — tests E2E audit trails and immutability triggers.
 * Run with: node test/test-audit.js
 */

const BASE = 'http://localhost:3000/api/v1';
const Database = require('better-sqlite3');
const path = require('path');
const config = require('../config');

async function post(path, body, headers = {}) {
  const res = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function get(path, headers = {}) {
  const res = await fetch(BASE + path, {
    headers,
  });
  return res.json();
}

async function main() {
  console.log('');
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  Phase 5 Verification: Audit Trail Engine & Immutability');
  console.log('═══════════════════════════════════════════════════════════');

  // ══════════════════════════════════════════════════════════════════
  //  TEST 1: Run complete happy path transaction and fetch audit logs
  // ══════════════════════════════════════════════════════════════════
  console.log('\n── TEST 1: Happy Path E2E Flow with Audit Trail Logging ──\n');

  // Step 1: Create Intent (Logs REQUEST)
  console.log('STEP 1: Create Intent Mandate (₹3,000 cap, footwear)');
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

  if (intent.status !== 'success') {
    throw new Error(`Failed to create intent: ${intent.message}`);
  }
  const intentId = intent.data.mandate_id;
  console.log('  ✓ Intent Mandate ID:', intentId);

  // Step 2: Search products passing intent ID in headers (Logs DISCOVERY)
  console.log('STEP 2: Search catalog for "shoes" (passes X-Audit-Trail-Id)');
  const searchResult = await get('/catalog/search?q=shoes', {
    'X-Audit-Trail-Id': intentId,
    'X-Agent-Id': 'agent_shopper_01',
  });
  console.log('  ✓ Search found:', searchResult.data.total_matches, 'results');

  // Step 3: Create Cart (Logs DECISION and MANDATE_CHECK)
  console.log('STEP 3: Create Cart (Nike Pegasus ₹2,799) within constraints');
  const cart = await post('/mandates/cart', {
    intent_mandate_id: intentId,
    agent_id: 'agent_shopper_01',
    items: [{
      product_id: 'prod_nike_pegasus',
      variant_id: 'var_nike_peg_10_black',
      quantity: 1,
    }],
    reasoning: {
      query: 'shoes',
      reason: 'Nike Pegasus is in stock and fits the budget.',
      alternatives: [],
    },
  });

  if (cart.status !== 'success') {
    throw new Error(`Failed to create cart: ${cart.message}`);
  }
  const cartId = cart.data.mandate_id;
  console.log('  ✓ Cart Mandate ID:', cartId);

  // Step 4: Approve Cart (Logs APPROVAL)
  console.log('STEP 4: Human approves cart');
  const approval = await post(`/mandates/cart/${cartId}/approve`, {
    approved_by: 'user_jane_doe',
  });

  if (approval.status !== 'success') {
    throw new Error(`Failed to approve cart: ${approval.message}`);
  }
  const paymentMandateId = approval.data.mandate_id;
  console.log('  ✓ Payment Mandate ID:', paymentMandateId);

  // Step 5: Execute Payment (Logs PAYMENT and OUTCOME)
  console.log('STEP 5: Execute payment');
  const payment = await post('/payments/execute', {
    payment_mandate_id: paymentMandateId,
    agent_id: 'agent_shopper_01',
    payment_method: 'upi',
  });

  if (payment.status !== 'success') {
    throw new Error(`Failed to execute payment: ${payment.message}`);
  }
  const transactionId = payment.data.transaction_id;
  console.log('  ✓ Transaction ID:', transactionId);

  // Step 6: Query and inspect the Audit Trail
  console.log('\nSTEP 6: Fetch audit trail by trail ID');
  const trailResult = await get(`/audit/trails/${intentId}`);
  if (trailResult.status !== 'success') {
    throw new Error(`Failed to retrieve audit trail: ${trailResult.message}`);
  }

  const steps = trailResult.data.timeline.map(e => e.step);
  console.log('  ✓ Chronological Steps in Audit Log:', steps.join(' → '));

  const expectedSteps = ['REQUEST', 'DISCOVERY', 'DECISION', 'MANDATE_CHECK', 'APPROVAL', 'PAYMENT', 'OUTCOME'];
  for (const step of expectedSteps) {
    if (!steps.includes(step)) {
      throw new Error(`Missing expected audit step: ${step}`);
    }
  }
  console.log('  ✅ All 7 lifecycle steps successfully recorded in sequence!');

  // Verify transaction timeline query
  console.log('STEP 7: Verify transaction audit endpoint');
  const txnTimeline = await get(`/audit/transactions/${transactionId}`);
  if (txnTimeline.status !== 'success' || txnTimeline.data.timeline.length === 0) {
    throw new Error('Failed to query audit timeline by transaction ID');
  }
  console.log('  ✓ Timeline items found:', txnTimeline.data.total_entries);
  console.log('  ✅ E2E Audit Trail Flow test PASSED!\n');

  // ══════════════════════════════════════════════════════════════════
  //  TEST 2: Database Immutability Verification (UPDATE/DELETE triggers)
  // ══════════════════════════════════════════════════════════════════
  console.log('── TEST 2: Database Immutability Verification (Triggers) ──\n');

  const dbPath = path.resolve(__dirname, '..', config.db.path);
  console.log('  Opening database at:', dbPath);
  const db = new Database(dbPath);

  // Pick an entry to test with
  const entry = db.prepare('SELECT entry_id FROM audit_entries LIMIT 1').get();
  if (!entry) {
    throw new Error('No audit entries found in DB to test immutability!');
  }
  console.log('  ✓ Test entry selected:', entry.entry_id);

  // Attempt manual update
  console.log('  Attempting UPDATE on audit_entries table...');
  try {
    db.prepare('UPDATE audit_entries SET step = ? WHERE entry_id = ?').run('MALICIOUS', entry.entry_id);
    throw new Error('CRITICAL ERROR: UPDATE was allowed on audit_entries! Triggers failed.');
  } catch (err) {
    if (err.message.includes('Audit entries are immutable')) {
      console.log('  ✓ UPDATE blocked correctly! Message:', err.message);
    } else {
      throw err;
    }
  }

  // Attempt manual delete
  console.log('  Attempting DELETE on audit_entries table...');
  try {
    db.prepare('DELETE FROM audit_entries WHERE entry_id = ?').run(entry.entry_id);
    throw new Error('CRITICAL ERROR: DELETE was allowed on audit_entries! Triggers failed.');
  } catch (err) {
    if (err.message.includes('Audit entries are immutable')) {
      console.log('  ✓ DELETE blocked correctly! Message:', err.message);
    } else {
      throw err;
    }
  }

  db.close();
  console.log('\n  ✅ TEST 2 PASSED: DB Immutability triggers are verified and working!');
  console.log('');
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  ✅ ALL AUDIT TESTS PASSED — Phase 5 Completed!');
  console.log('═══════════════════════════════════════════════════════════');
  console.log('');
}

main().catch(err => {
  console.error('\n✗ TEST FAILED:', err.message);
  console.error(err.stack);
  process.exit(1);
});
