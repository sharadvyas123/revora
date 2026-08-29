/**
 * @file test/test-tools.js
 * @description Test suite for Phase 14: Expanded Agent Tooling v2
 *
 * Validates all 9 LLM function-calling tools:
 *   1. Schema completeness (name, description, parameters, execute)
 *   2. Registry integrity (allTools, toolMap, dispatchTool, getToolSchemas)
 *   3. Live HTTP integration against running gateway (server must be on :3000)
 *
 * Usage:
 *   node test/test-tools.js
 *
 * Prerequisites for integration tests:
 *   npm run reset-db && npm run dev
 */

'use strict';

require('dotenv').config();

// ── Test Harness ─────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
let skipped = 0;
const total_start = Date.now();

function assert(condition, label) {
  if (condition) {
    console.log(`  ✔ ${label}`);
    passed++;
  } else {
    console.error(`  ✘ ${label}`);
    failed++;
  }
}

function skip(label) {
  console.log(`  ○ SKIP ${label}`);
  skipped++;
}

async function test(label, fn) {
  console.log(`\n▶ ${label}`);
  try {
    await fn();
  } catch (err) {
    console.error(`  ✘ Unexpected error: ${err.message}`);
    failed++;
  }
}

async function httpGet(path) {
  const BASE = 'http://localhost:3000';
  const res = await fetch(`${BASE}${path}`);
  const json = await res.json();
  return { status: res.status, body: json };
}

async function httpPost(path, body, headers = {}) {
  const BASE = 'http://localhost:3000';
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  return { status: res.status, body: json };
}

// ── Load the tools registry ──────────────────────────────────────────

const {
  allTools,
  toolMap,
  dispatchTool,
  getToolSchemas,
  searchCatalogTool,
  searchWebTool,
  getProductTool,
  compareProductsTool,
  findCouponsTool,
  validateCouponTool,
  createCartTool,
  requestPurchaseConfirmationTool,
  executePaymentTool,
} = require('../agent/tools/index');

// ── Constants ─────────────────────────────────────────────────────────

const EXPECTED_TOOLS = [
  'search_catalog',
  'search_web',
  'get_product',
  'compare_products',
  'find_coupons',
  'validate_coupon',
  'create_cart',
  'request_purchase_confirmation',
  'execute_payment',
];

const MERCHANT_ID = 'merch_sportshub';

// ─────────────────────────────────────────────────────────────────────
// SECTION 1: Registry Integrity
// ─────────────────────────────────────────────────────────────────────

async function runAllTests() {
  console.log('\n════════════════════════════════════════════════════════');
  console.log('  Phase 14: Expanded Agent Tooling v2 — Tests');
  console.log('════════════════════════════════════════════════════════');

  await test('1. Registry — allTools count', async () => {
    assert(allTools.length === 9, `allTools has exactly 9 tools (got ${allTools.length})`);
  });

  await test('2. Registry — all expected tool names present', async () => {
    const registeredNames = allTools.map((t) => t.name);
    for (const name of EXPECTED_TOOLS) {
      assert(registeredNames.includes(name), `tool "${name}" is registered`);
    }
  });

  await test('3. Registry — toolMap O(1) lookup', async () => {
    for (const name of EXPECTED_TOOLS) {
      assert(toolMap[name] !== undefined, `toolMap["${name}"] exists`);
      assert(toolMap[name].name === name, `toolMap["${name}"].name === "${name}"`);
    }
  });

  await test('4. Registry — dispatchTool throws for unknown tool', async () => {
    let threw = false;
    try {
      await dispatchTool('nonexistent_tool', {});
    } catch (err) {
      threw = true;
      assert(err.message.includes('Unknown tool'), 'Error message mentions "Unknown tool"');
    }
    assert(threw, 'dispatchTool throws for unknown tool name');
  });

  await test('5. Registry — getToolSchemas() returns correct shape', async () => {
    const schemas = getToolSchemas();
    assert(schemas.length === 9, `getToolSchemas returns 9 schemas`);
    for (const schema of schemas) {
      assert(typeof schema.name === 'string', `schema.name is string for ${schema.name}`);
      assert(typeof schema.description === 'string', `schema.description is string for ${schema.name}`);
      assert(schema.parameters && schema.parameters.type === 'object', `schema.parameters.type=object for ${schema.name}`);
      assert(!schema.execute, `schema does not expose execute() for ${schema.name}`);
    }
  });

  // ─────────────────────────────────────────────────────────────────────
  // SECTION 2: Individual Tool Schema Validation
  // ─────────────────────────────────────────────────────────────────────

  const TOOL_CASES = [
    {
      tool: searchCatalogTool,
      requiredParams: ['query'],
      name: 'search_catalog',
    },
    {
      tool: searchWebTool,
      requiredParams: ['query'],
      name: 'search_web',
    },
    {
      tool: getProductTool,
      requiredParams: ['product_id'],
      name: 'get_product',
    },
    {
      tool: compareProductsTool,
      requiredParams: ['product_ids'],
      name: 'compare_products',
    },
    {
      tool: findCouponsTool,
      requiredParams: ['merchant_id'],
      name: 'find_coupons',
    },
    {
      tool: validateCouponTool,
      requiredParams: ['coupon_code', 'merchant_id', 'amount'],
      name: 'validate_coupon',
    },
    {
      tool: createCartTool,
      requiredParams: ['intent_mandate_id', 'agent_id', 'items'],
      name: 'create_cart',
    },
    {
      tool: requestPurchaseConfirmationTool,
      requiredParams: ['cart_mandate_id', 'user_confirmation', 'channel'],
      name: 'request_purchase_confirmation',
    },
    {
      tool: executePaymentTool,
      requiredParams: ['payment_mandate_id', 'agent_id'],
      name: 'execute_payment',
    },
  ];

  for (const { tool, requiredParams, name } of TOOL_CASES) {
    await test(`6. Schema — ${name}`, async () => {
      assert(tool.name === name, `tool.name === "${name}"`);
      assert(typeof tool.description === 'string' && tool.description.length > 0, 'description is non-empty string');
      assert(tool.parameters && tool.parameters.type === 'object', 'parameters.type === "object"');
      assert(Array.isArray(tool.parameters.required), 'parameters.required is array');
      for (const p of requiredParams) {
        assert(tool.parameters.required.includes(p), `required param "${p}" declared`);
        assert(tool.parameters.properties[p] !== undefined, `property "${p}" defined in schema`);
      }
      assert(typeof tool.execute === 'function', 'execute is a function');
    });
  }

  // ─────────────────────────────────────────────────────────────────────
  // SECTION 3: Integration Tests (live server required)
  // ─────────────────────────────────────────────────────────────────────

  let serverUp = false;
  try {
    const health = await httpGet('/health');
    serverUp = health.status === 200;
  } catch (_) {
    serverUp = false;
  }

  await test('7. Integration — server connectivity', async () => {
    if (!serverUp) {
      skip('Server not running on localhost:3000');
      return;
    }
    assert(serverUp, 'GET /health returns 200');
  });

  await test('8. Integration — search_web tool executes', async () => {
    if (!serverUp) { skip('Server not running'); return; }
    const result = await searchWebTool.execute({ query: 'running shoes', max_price: 400000 });
    assert(result.query !== undefined, 'result has query field');
    assert(Array.isArray(result.results), 'result.results is array');
    assert(typeof result.total_found === 'number', 'result.total_found is number');
  });

  await test('9. Integration — find_coupons tool executes', async () => {
    if (!serverUp) { skip('Server not running'); return; }
    const result = await findCouponsTool.execute({ merchant_id: MERCHANT_ID });
    assert(typeof result.merchant_id === 'string', 'result.merchant_id exists');
    assert(Array.isArray(result.coupons), 'result.coupons is array');
    assert(result.coupons.length > 0, `at least one coupon found (got ${result.coupons.length})`);
  });

  await test('10. Integration — validate_coupon tool executes (valid code)', async () => {
    if (!serverUp) { skip('Server not running'); return; }
    const result = await validateCouponTool.execute({
      coupon_code: 'RUN500',
      merchant_id: MERCHANT_ID,
      amount: 279900, // ₹2,799
      category: 'footwear',
    });
    assert(result.valid === true, 'RUN500 is valid for ₹2,799 footwear order');
    assert(typeof result.discount_amount === 'number', 'discount_amount is a number');
    assert(result.discount_amount === 50000, `discount_amount === 50000 paise (₹500), got ${result.discount_amount}`);
    assert(result.final_amount === 229900, `final_amount === 229900 paise (₹2,299), got ${result.final_amount}`);
  });

  await test('11. Integration — validate_coupon tool returns error for invalid code', async () => {
    if (!serverUp) { skip('Server not running'); return; }
    const result = await validateCouponTool.execute({
      coupon_code: 'FAKECODE999',
      merchant_id: MERCHANT_ID,
      amount: 279900,
    });
    assert(result.valid === false, 'Invalid code returns valid: false');
    assert(typeof result.error_code === 'string', 'error_code is present');
  });

  await test('12. Integration — compare_products tool executes', async () => {
    if (!serverUp) { skip('Server not running'); return; }
    const result = await compareProductsTool.execute({
      product_ids: ['prod_nike_pegasus', 'prod_asics_gel'],
      intent: { query: 'running shoes', max_price: 300000, category: 'footwear' },
    });
    assert(Array.isArray(result.candidates), 'result.candidates is array');
    assert(result.candidates.length >= 1, 'at least one candidate in comparison');
  });

  await test('13. Integration — dispatchTool routes to find_coupons', async () => {
    if (!serverUp) { skip('Server not running'); return; }
    const result = await dispatchTool('find_coupons', { merchant_id: MERCHANT_ID });
    assert(Array.isArray(result.coupons), 'dispatched find_coupons returns coupons array');
  });

  await test('14. Integration — dispatchTool routes to search_web', async () => {
    if (!serverUp) { skip('Server not running'); return; }
    const result = await dispatchTool('search_web', { query: 'running shoes' });
    assert(Array.isArray(result.results), 'dispatched search_web returns results array');
  });

  // ─────────────────────────────────────────────────────────────────────
  // SUMMARY
  // ─────────────────────────────────────────────────────────────────────

  const total = passed + failed + skipped;
  console.log('\n════════════════════════════════════════════════════════');
  console.log(`  Passed:  ${passed}`);
  console.log(`  Failed:  ${failed}`);
  console.log(`  Skipped: ${skipped}`);
  console.log(`  Total:   ${total}`);
  console.log('════════════════════════════════════════════════════════\n');
  console.log(`${passed}/${total - skipped} tests passed\n`);

  if (failed > 0) process.exit(1);
}

runAllTests().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
