/**
 * @module demo/run-demo
 * @description Master Demo CLI Orchestrator for Agentic Commerce Gateway (ACG).
 * 
 * Runs all 4 demonstration scenarios sequentially:
 *   1. Happy Path — Autonomous Bounded Purchase
 *   2. Spend Cap Violation — Safe Gateway Block
 *   3. Ambiguous Query — Zero Blind Spend Guard
 *   4. Payment Failure — Safe Transaction Rollback
 * 
 * Usage:
 *   node demo/run-demo.js
 *   npm run demo
 */

const runHappyPath = require('./scenarios/happy-path');
const runSpendCapExceeded = require('./scenarios/spend-cap-exceeded');
const runAmbiguousMatch = require('./scenarios/ambiguous-match');
const runPaymentDeclined = require('./scenarios/payment-declined');
const generateReport = require('./report');

async function runFullDemoSuite() {
  console.log('\n');
  console.log('===================================================================');
  console.log('  🚀 AGENTIC COMMERCE GATEWAY (ACG) — FULL DEMO SUITE');
  console.log('  Building Safe, Bounded, Gated & Auditable Autonomous Commerce');
  console.log('===================================================================\n');

  let passed = 0;
  let failed = 0;
  let happyTrailId = null;

  // Scenario 1
  try {
    const res1 = await runHappyPath();
    happyTrailId = res1.steps?.intent_mandate?.mandate_id;
    passed++;
  } catch (e) {
    console.error('Scenario 1 Error:', e.message);
    failed++;
  }

  // Scenario 2
  try {
    await runSpendCapExceeded();
    passed++;
  } catch (e) {
    console.error('Scenario 2 Error:', e.message);
    failed++;
  }

  // Scenario 3
  try {
    await runAmbiguousMatch();
    passed++;
  } catch (e) {
    console.error('Scenario 3 Error:', e.message);
    failed++;
  }

  // Scenario 4
  try {
    await runPaymentDeclined();
    passed++;
  } catch (e) {
    console.error('Scenario 4 Error:', e.message);
    failed++;
  }

  // Visual Audit Report for Scenario 1
  if (happyTrailId) {
    try {
      await generateReport(happyTrailId);
    } catch (e) {
      console.warn('Could not generate visual audit report:', e.message);
    }
  }

  console.log('===================================================================');
  console.log(`  📊 DEMO SUMMARY: ${passed}/4 Scenarios Passed (${failed} Failed)`);
  if (failed === 0) {
    console.log('  ✅ ALL DEMO SCENARIOS PASSED — Gateway Safety Fully Demonstrated!');
  }
  console.log('===================================================================\n');
}

if (require.main === module) {
  runFullDemoSuite().catch(() => process.exit(1));
}

module.exports = runFullDemoSuite;
