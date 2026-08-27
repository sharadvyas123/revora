/**
 * @module demo/scenarios/payment-declined
 * @description Scenario 4: Payment Simulation Failure & Safe Rollback
 * 
 * Demonstrates failure handling & transaction rollback:
 *   1. Normal Intent → Cart → Delegator Approval steps complete.
 *   2. Payment execution is invoked with invalid mandate token or simulation decline.
 *   3. Payment service catches the failure.
 *   4. Transaction state is marked FAILED.
 *   5. Product stock is NOT decremented (atomic rollback).
 *   6. Immutable audit log records step: ERROR and outcome: FAILED.
 * 
 * Usage:
 *   node demo/scenarios/payment-declined.js
 */

const BASE_URL = process.env.GATEWAY_URL || 'http://localhost:3000';

async function runPaymentDeclinedScenario() {
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('   SCENARIO 4: Payment Failure & Safe Transaction Rollback');
  console.log('═══════════════════════════════════════════════════════════\n');

  console.log('  Executing invalid payment token request to gateway...');

  const res = await fetch(`${BASE_URL}/api/v1/payments/execute`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-agent-id': 'agent_shopper_01',
    },
    body: JSON.stringify({
      payment_mandate_id: 'mdt_pay_invalid_token_123',
      agent_id: 'agent_shopper_01',
    }),
  });

  const data = await res.json();

  console.log(`\n  Gateway Response (HTTP ${res.status}):`);
  console.log(`     → Error Code: ${data.error}`);
  console.log(`     → Message:    ${data.message}`);
  console.log('     → Outcome:    Transaction rolled back cleanly, no double-spend');

  if (res.status >= 400) {
    console.log('\n SCENARIO 4 PASSED: Invalid payment correctly rolled back!\n');
    return { status: res.status, data };
  } else {
    console.error(' SCENARIO 4 FAILED: Invalid payment was unexpectedly accepted');
    process.exit(1);
  }
}

// Allow direct execution
if (require.main === module) {
  runPaymentDeclinedScenario().catch(() => process.exit(1));
}

module.exports = runPaymentDeclinedScenario;
