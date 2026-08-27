/**
 * @module demo/scenarios/happy-path
 * @description Scenario 1: Autonomous Bounded Purchase Flow
 * 
 * Demonstrates the primary success path of the Agentic Commerce Gateway (ACG):
 *   1. Human prompt: "buy running shoes under 3000 rupees"
 *   2. Intent Mandate created with max_amount = ₹3,000 (300,000 paise)
 *   3. Catalog search discovers matching candidates
 *   4. Decision Engine (Gemini LLM / local scoring) selects optimal candidate
 *   5. Cart Mandate created with full AI reasoning & candidate comparison
 *   6. Human delegator approves the Cart Mandate
 *   7. Razorpay test-mode payment executed & signature verified
 *   8. Complete audit trail verified in immutable storage
 * 
 * Usage:
 *   node demo/scenarios/happy-path.js
 */

const Agent = require('../../agent/agent');

const BASE_URL = process.env.GATEWAY_URL || 'http://localhost:3000';

async function runHappyPathScenario() {
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('  SCENARIO 1: Autonomous Bounded Purchase (Happy Path)');
  console.log('═══════════════════════════════════════════════════════════\n');

  const agent = new Agent({
    agentId: 'agent_shopper_01',
    delegatorId: 'user_jane_doe',
    gatewayUrl: BASE_URL,
  });

  const prompt = 'buy running shoes under 3000 rupees';
  const startTime = Date.now();

  try {
    const result = await agent.run(prompt);

    console.log('\n── Scenario Summary ──\n');
    console.log(`  ✓ Prompt:            "${prompt}"`);
    console.log(`  ✓ Status:            ${result.status}`);
    console.log(`  ✓ Transaction ID:    ${result.steps.payment?.transaction_id}`);
    console.log(`  ✓ Product Selected:  ${result.steps.decision?.selected?.name}`);
    console.log(`  ✓ Amount Paid:       ${result.steps.payment?.amount_display}`);
    console.log(`  ✓ Audit Trail ID:    ${result.steps.intent_mandate?.mandate_id}`);
    console.log(`  ✓ Total Duration:    ${Date.now() - startTime}ms`);

    console.log('\n SCENARIO 1 COMPLETED SUCCESSFULLY!\n');
    return result;
  } catch (err) {
    console.error(`\n SCENARIO 1 FAILED: ${err.message}\n`);
    throw err;
  }
}

// Allow direct execution
if (require.main === module) {
  runHappyPathScenario().catch(() => process.exit(1));
}

module.exports = runHappyPathScenario;