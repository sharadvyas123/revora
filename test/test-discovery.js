/**
 * Phase 9 Multi-Source Discovery Test Suite
 * 
 * Tests the multi-source product discovery and normalization pipeline:
 *   Test 1: Multi-Source Search (Local Catalog + External Web)
 *   Test 2: Unified Schema Normalization Verification
 *   Test 3: Filter Enforcement (price caps, categories, local-only mode)
 *   Test 4: Input Validation & Edge Cases (Zod schema bounds)
 *   Test 5: External Product Database Cache
 * 
 * Prerequisites:
 *   1. node db/reset.js
 *   2. node gateway/server.js (running on port 3000)
 *   3. node test/test-discovery.js
 */

const BASE = 'http://localhost:3000/api/v1/discovery';
const HEALTH = 'http://localhost:3000/health';

let passed = 0;
let failed = 0;

// ── Helpers ─────────────────────────────────────────────────────────

async function request(path, { headers = {} } = {}) {
  const res = await fetch(BASE + path, {
    method: 'GET',
    headers: { 'Content-Type': 'application/json', ...headers },
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
  console.log(`  ✓ Gateway running on http://localhost:3000`);
  console.log(`  ✓ Database status: ${data.database.products} products, ${data.database.merchants} merchant`);
}

// ════════════════════════════════════════════════════════════════════
//  TEST 1: MULTI-SOURCE PRODUCT SEARCH
// ════════════════════════════════════════════════════════════════════

async function testMultiSourceSearch() {
  section('TEST 1: Multi-Source Product Search (Local + External Web)');

  const { status, data } = await request('/search?q=running+shoes&limit=6');

  assert(status === 200, `HTTP Status is 200 OK (got ${status})`);
  assert(data.status === 'success', `Response status is 'success'`);
  assert(data.data.query === 'running shoes', `Query returned matches request`);
  assert(Array.isArray(data.data.results), `Results is an array`);
  assert(data.data.results.length > 0, `Returned candidates count: ${data.data.results.length}`);

  const sources = data.data.sources_queried;
  assert(sources.includes('LOCAL_CATALOG'), `Sources queried includes LOCAL_CATALOG`);
  assert(sources.includes('EXTERNAL_WEB'), `Sources queried includes EXTERNAL_WEB`);

  const hasLocal = data.data.results.some((r) => r.match_source === 'LOCAL_CATALOG');
  const hasExternal = data.data.results.some((r) => r.match_source === 'EXTERNAL_WEB');

  assert(hasLocal, `Results contain candidates from LOCAL_CATALOG`);
  assert(hasExternal, `Results contain candidates from EXTERNAL_WEB`);
}

// ════════════════════════════════════════════════════════════════════
//  TEST 2: UNIFIED SCHEMA NORMALIZATION VERIFICATION
// ════════════════════════════════════════════════════════════════════

async function testSchemaNormalization() {
  section('TEST 2: Unified Schema Normalization Verification');

  const { data } = await request('/search?q=running+shoes&limit=10');
  const results = data.data.results;

  const localItem = results.find((r) => r.match_source === 'LOCAL_CATALOG')?.product;
  const externalItem = results.find((r) => r.match_source === 'EXTERNAL_WEB')?.product;

  assert(!!localItem, `Local product candidate retrieved for schema validation`);
  assert(!!externalItem, `External product candidate retrieved for schema validation`);

  // Required fields check on local product
  if (localItem) {
    assert(typeof localItem.product_id === 'string', `Local product has product_id`);
    assert(localItem.source_type === 'LOCAL_CATALOG', `Local product source_type is LOCAL_CATALOG`);
    assert(typeof localItem.price.amount === 'number', `Local product price amount is numeric (paise)`);
    assert(typeof localItem.price.display === 'string', `Local product price has formatted display (e.g. ₹2,799.00)`);
    assert(typeof localItem.stock.available === 'boolean', `Local product stock availability is boolean`);
    assert(typeof localItem.fetched_at === 'string', `Local product has fetched_at ISO timestamp`);
  }

  // Required fields check on external product
  if (externalItem) {
    assert(typeof externalItem.product_id === 'string', `External product has product_id`);
    assert(externalItem.source_type === 'EXTERNAL_WEB', `External product source_type is EXTERNAL_WEB`);
    assert(typeof externalItem.price.amount === 'number', `External product price amount is numeric (paise)`);
    assert(typeof externalItem.price.display === 'string', `External product price has formatted display`);
    assert(typeof externalItem.stock.available === 'boolean', `External product stock availability is boolean`);
    assert(typeof externalItem.fetched_at === 'string', `External product has fetched_at ISO timestamp`);
  }
}

// ════════════════════════════════════════════════════════════════════
//  TEST 3: FILTERS & SEARCH SCOPING
// ════════════════════════════════════════════════════════════════════

async function testFiltersAndScoping() {
  section('TEST 3: Filter Enforcement & Search Scoping');

  // Test 3.1: Max Price Filter (e.g. max ₹2,000 = 200000 paise)
  const maxPricePaise = 200000;
  const { data: priceFiltered } = await request(`/search?q=running+shoes&max_price=${maxPricePaise}`);
  const overPriced = priceFiltered.data.results.filter((r) => r.product.price.amount > maxPricePaise);

  assert(overPriced.length === 0, `Max price filter enforced (0 candidates exceed ₹2,000)`);

  // Test 3.2: Category Filter
  const { data: catFiltered } = await request('/search?q=running&category=footwear');
  const nonFootwear = catFiltered.data.results.filter((r) => r.product.category !== 'footwear');

  assert(nonFootwear.length === 0, `Category filter enforced (all items are 'footwear')`);

  // Test 3.3: Local-Only Mode
  const { data: localOnly } = await request('/search?q=running+shoes&local_only=true');
  const sources = localOnly.data.sources_queried;
  const extCount = localOnly.data.results.filter((r) => r.match_source === 'EXTERNAL_WEB').length;

  assert(sources.length === 1 && sources[0] === 'LOCAL_CATALOG', `local_only=true queries LOCAL_CATALOG only`);
  assert(extCount === 0, `0 external web candidates returned when local_only=true`);
}

// ════════════════════════════════════════════════════════════════════
//  TEST 4: INPUT VALIDATION & EDGE CASES
// ════════════════════════════════════════════════════════════════════

async function testInputValidation() {
  section('TEST 4: Input Validation & Edge Cases');

  // Test 4.1: Missing search query 'q'
  const { status: status1 } = await request('/search');
  assert(status1 === 400, `Missing query parameter 'q' returns HTTP 400 Bad Request`);

  // Test 4.2: Negative max_price
  const { status: status2 } = await request('/search?q=shoes&max_price=-500');
  assert(status2 === 400, `Negative max_price returns HTTP 400 Bad Request`);

  // Test 4.3: Exceed limit max bound (limit > 50)
  const { status: status3 } = await request('/search?q=shoes&limit=100');
  assert(status3 === 400, `Limit exceeding max (100 > 50) returns HTTP 400 Bad Request`);
}

// ════════════════════════════════════════════════════════════════════
//  TEST 5: EXTERNAL PRODUCT DATABASE CACHE
// ════════════════════════════════════════════════════════════════════

async function testDatabaseCache() {
  section('TEST 5: External Product Database Cache');

  // Perform search that populates cache
  const uniqueQuery = 'marathon' + Math.floor(Math.random() * 1000);
  const { status: status1, data: res1 } = await request(`/search?q=${uniqueQuery}`);
  assert(status1 === 200, `First search (cold cache) succeeds`);

  // Perform exact same search (warm cache hit)
  const { status: status2, data: res2 } = await request(`/search?q=${uniqueQuery}`);
  assert(status2 === 200, `Second search (warm cache HIT) succeeds`);
  assert(res1.data.results.length === res2.data.results.length, `Cached search returns identical result count`);
}

// ════════════════════════════════════════════════════════════════════
//  MAIN RUNNER
// ════════════════════════════════════════════════════════════════════

async function run() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  Phase 9: Multi-Source Discovery & Normalization Test Suite');
  console.log('═══════════════════════════════════════════════════════════');

  try {
    await preflight();
    await testMultiSourceSearch();
    await testSchemaNormalization();
    await testFiltersAndScoping();
    await testInputValidation();
    await testDatabaseCache();

    console.log('\n═══════════════════════════════════════════════════════════');
    console.log(`  RESULTS: ${passed} passed, ${failed} failed`);
    console.log('═══════════════════════════════════════════════════════════\n');

    process.exit(failed > 0 ? 1 : 0);
  } catch (err) {
    console.error('\n❌ Test suite failed with error:', err.message);
    process.exit(1);
  }
}

run();
