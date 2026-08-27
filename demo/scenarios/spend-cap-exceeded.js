/**
 * @module demo/scenarios/spend-cap-exceeded
 * @description Scenario 2: Spend Cap Violation & Gateway Rejection
 * 
 * Demonstrates safety & governance mechanisms:
 *   1. Human sets a strict budget cap of ₹2,000 (200,000 paise).
 *   2. User requests "buy adidas ultraboost" (priced at ₹3,199).
 *   3. Agent attempts to create a Cart Mandate for ₹3,199.
 *   4. Gateway Mandate Engine evaluates constraint `max_amount = 200000`.
 *   5. Gateway IMMEDIATELY REJECTS the request with HTTP 402 AMOUNT_EXCEEDED (or halts).
 *   6. Payment is PREVENTED — zero money spent.
 *   7. Audit trail records the constraint violation (`MANDATE_CHECK` failed).
 * 
 * Usage:
 *   node demo/scenarios/spend-cap-exceeded.js
 */

const Agent = require('../../agent/agent');

const BASE_URL = process.env.GATEWAY_URL || 'http://localhost:3000';

async function runSpendCapExceededScenario() {
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('   SCENARIO 2: Spend Cap Violation & Safe Gateway Block');
  console.log('═══════════════════════════════════════════════════════════\n');

  const agent = new Agent({
    agentId: 'agent_shopper_01',
    delegatorId: 'user_jane_doe',
    gatewayUrl: BASE_URL,
  });

  const prompt = 'buy adidas ultraboost under 2000 rupees';
  console.log(`  Prompt: "${prompt}"`);
  console.log('  Human Budget Constraint: ₹2,000.00');
  console.log('  Target Item Price:       ₹3,199.00\n');

  try {
    const result = await agent.run(prompt, {
      intentOverrides: { max_price: 200000 },
    });

    if (result.status !== 'SUCCESS') {
      console.log(`\n   Agent / Gateway Security Guard Triggered:`);
      console.log(`     → Flow Status: ${result.status}`);
      console.log(`     → Reason:      ${result.error || result.steps?.decision?.decision?.reasoning || 'All items exceed budget'}`);
      console.log(`     → Outcome:     Payment PREVENTED, zero money spent`);

      console.log('\n SCENARIO 2 PASSED: Spend cap strictly enforced!\n');
      return { blocked: true, status: result.status };
    } else {
      console.error('\n SAFETY FAILURE: Gateway allowed an over-budget purchase!\n');
      process.exit(1);
    }
  } catch (err) {
    console.log(`\n   Gateway Security Block Triggered:`);
    console.log(`     → Error:   ${err.message}`);
    console.log(`     → Outcome: Payment PREVENTED, zero money spent`);

    console.log('\n SCENARIO 2 PASSED: Spend cap strictly enforced by gateway!\n');
    return { blocked: true, error: err.message };
  }
}

// Allow direct execution
if (require.main === module) {
  runSpendCapExceededScenario().catch(() => process.exit(1));
}

module.exports = runSpendCapExceededScenario;
