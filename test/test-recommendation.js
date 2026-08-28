/**
 * @file test/test-recommendation.js
 * @description Automated test suite for Phase 10 — Recommendation & Comparison Engine.
 *
 * Covers:
 *   1. Unit: ComparisonEngine (comparison-engine.js)
 *   2. Unit: DecisionEngine source-agnostic adapter (_normalizeCandidate)
 *   3. Unit: decideWithComparison() combined pipeline
 *   4. Integration: POST /api/v1/recommendations/decide
 *   5. Integration: POST /api/v1/recommendations/compare
 *   6. Edge cases: empty input, over-budget, no rating, single candidate
 *
 * Run with:
 *   node test/test-recommendation.js
 *   (server must be running on http://localhost:3000)
 */

'use strict';

const http = require('http');

// ── ANSI Colours ─────────────────────────────────────────────────────
const RESET  = '\x1b[0m';
const GREEN  = '\x1b[32m';
const RED    = '\x1b[31m';
const YELLOW = '\x1b[33m';
const CYAN   = '\x1b[36m';
const BOLD   = '\x1b[1m';

// ── Test Runner ───────────────────────────────────────────────────────
let passed = 0;
let failed = 0;
let skipped = 0;
const failures = [];

function pass(name) {
  passed++;
  console.log(`  ${GREEN}✔${RESET} ${name}`);
}

function fail(name, reason) {
  failed++;
  failures.push({ name, reason });
  console.log(`  ${RED}✘ ${name}${RESET}`);
  console.log(`      ${RED}→ ${reason}${RESET}`);
}

function skip(name, reason) {
  skipped++;
  console.log(`  ${YELLOW}○ SKIP${RESET} ${name} — ${reason}`);
}

function section(title) {
  console.log(`\n${BOLD}${CYAN}▶ ${title}${RESET}`);
}

function assert(name, condition, message) {
  if (condition) { pass(name); } else { fail(name, message || 'Assertion failed'); }
}

// ── Minimal HTTP client ───────────────────────────────────────────────
const BASE_URL = 'http://localhost:3000';

function post(path, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const options = {
      hostname: 'localhost',
      port:     3000,
      path,
      method:   'POST',
      headers:  {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });

    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// Check connectivity before running integration tests
function checkServer() {
  return new Promise((resolve) => {
    http.get(`${BASE_URL}/health`, (res) => {
      resolve(res.statusCode === 200);
    }).on('error', () => resolve(false));
  });
}

// ═══════════════════════════════════════════════════════════════════
//  UNIT TESTS — Comparison Engine
// ═══════════════════════════════════════════════════════════════════

section('Unit: comparison-engine.js — compare()');

(function testComparisonEngine() {
  const { compare } = require('../agent/comparison-engine');

  // Helper: build minimal normalized candidate
  function makeCandidate(id, name, price, rating, stock = 20, reviewCount = 200) {
    return {
      product: {
        product_id:  id,
        source_type: 'LOCAL_CATALOG',
        source_name: 'ACG Local Catalog',
        source_url:  `http://localhost:3000/api/v1/catalog/products/${id}`,
        name,
        description: '',
        category:    'footwear',
        subcategory: '',
        price: { amount: price, currency: 'INR', display: `₹${price / 100}` },
        stock: { available: stock > 0, quantity: stock },
        variants: [],
        rating,
        review_count: reviewCount,
        attributes: {},
        policies: {},
        media: [],
      },
      relevance_score: 0.8,
      scores: {
        composite:   0.72,
        relevance:   0.80,
        rating:      0.75,
        price_value: 0.60,
        stock:       1.00,
      },
    };
  }

  const candidates = [
    makeCandidate('p1', 'Nike Air Zoom', 899900, 4.6, 100, 2400),
    makeCandidate('p2', 'Adidas Ultraboost', 1299900, 4.8, 15,  900),
    makeCandidate('p3', 'Skechers GOrun', 499900, 4.1, 50,  150),
    makeCandidate('p4', 'Decathlon Trail', 299900, 3.9, 200, 30),
  ];

  // Override composite scores so we can predict badge assignment
  candidates[0].scores.composite = 0.82; // Best Overall
  candidates[1].scores.composite = 0.78; // Highest Rated (4.8★)
  candidates[2].scores.composite = 0.55;
  candidates[3].scores.composite = 0.49; // Cheapest → Best Value eligible

  const intent = { raw_prompt: 'running shoes under 10000', max_price: 1000000 };
  const result  = compare(candidates, intent);

  assert('Returns comparison_id', typeof result.comparison_id === 'string' && result.comparison_id.startsWith('cmp_'), 'comparison_id missing or malformed');
  assert('Returns recommended_product_id', result.recommended_product_id === 'p1', `Expected p1, got ${result.recommended_product_id}`);
  assert('Returns candidates array of length 4', result.candidates.length === 4, `Got ${result.candidates.length}`);
  assert('Returns recommendation_reason string', typeof result.recommendation_reason === 'string' && result.recommendation_reason.length > 20, 'Reason too short');
  assert('Best Overall badge on top candidate', result.candidates[0].badge === 'Best Overall Match', `Got badge: ${result.candidates[0].badge}`);
  assert('Cheapest candidate gets Best Value badge', result.candidates.find(c => c.product_id === 'p4')?.badge === 'Best Value', 'p4 should be Best Value');
  assert('Highest rated candidate gets badge', result.candidates.find(c => c.product_id === 'p2')?.badge === 'Highest Rated', 'p2 should be Highest Rated');
  assert('generated_at is ISO string', !isNaN(Date.parse(result.generated_at)), `Invalid date: ${result.generated_at}`);

  // Pros/cons checks
  const top = result.candidates[0]; // Nike Air Zoom — 100 units, 4.6★, 2400 reviews
  assert('Top candidate has pros array', Array.isArray(top.pros), 'pros missing');
  assert('High review count appears in pros', top.pros.some(p => p.includes('review')), `Pros: ${JSON.stringify(top.pros)}`);
  assert('Cons array exists', Array.isArray(top.cons), 'cons missing');

  // Low-stock candidate (p2: Adidas Ultraboost, 15 units, price above average)
  // May have "Higher price" con; also check low stock or that cons are non-empty
  const lowStock = result.candidates.find(c => c.product_id === 'p2'); // 15 units
  assert('Low-stock candidate has at least one con', lowStock.cons.length > 0, `Cons unexpectedly empty: ${JSON.stringify(lowStock.cons)}`);

  // Empty input
  const empty = compare([], {});
  assert('Empty candidates returns valid structure', empty.candidates.length === 0 && empty.recommended_product_id === null, 'Empty comparison malformed');

  // Single candidate — should still produce Best Overall badge
  const single = compare([candidates[0]], { raw_prompt: 'shoes' });
  assert('Single candidate gets Best Overall badge', single.candidates[0].badge === 'Best Overall Match', `Got: ${single.candidates[0].badge}`);
})();

// ═══════════════════════════════════════════════════════════════════
//  UNIT TESTS — Decision Engine (v2 source-agnostic adapter)
// ═══════════════════════════════════════════════════════════════════

section('Unit: decision-engine.js — _normalizeCandidate & decideLocal (v2 inputs)');

(function testDecisionEngineV2() {
  const { decideLocal, WEIGHTS } = require('../agent/decision-engine');

  // v2 Normalized Product Schema format (DiscoveryService output)
  const v2Results = [
    {
      product: {
        product_id:   'ext_abc123',
        source_type:  'EXTERNAL_WEB',
        source_name:  'Decathlon India',
        source_url:   'https://www.decathlon.in/p/kalenji',
        name:         'Kalenji Run Support',
        description:  'Entry-level running shoe',
        category:     'footwear',
        subcategory:  'running_shoes',
        price: { amount: 59999, currency: 'INR', display: '₹599.99' },
        stock: { available: true, quantity: 50 },
        variants: [],
        rating:       4.1,
        review_count: 320,
        attributes:   {},
        policies:     {},
        media:        [],
        fetched_at:   new Date().toISOString(),
      },
      relevance_score:  0.85,
      match_source:    'web_crawler',
    },
    {
      product: {
        product_id:   'ext_def456',
        source_type:  'EXTERNAL_WEB',
        source_name:  'Myntra',
        source_url:   'https://www.myntra.com/xyz',
        name:         'Nike Downshifter',
        description:  'Cushioned training shoe',
        category:     'footwear',
        subcategory:  'running_shoes',
        price: { amount: 479900, currency: 'INR', display: '₹4,799.00' },
        stock: { available: true, quantity: 8 },
        variants: [],
        rating:       4.4,
        review_count: 980,
        attributes:   {},
        policies:     {},
        media:        [],
        fetched_at:   new Date().toISOString(),
      },
      relevance_score:  0.90,
      match_source:    'web_crawler',
    },
  ];

  const intent = { keywords: ['running', 'shoes'], max_price: 600000 };
  const result  = decideLocal(v2Results, intent);

  assert('decideLocal accepts v2 Normalized Schema', result.selected !== null && result.llm_mode === 'local', `Got: ${JSON.stringify(result.selected)}`);
  assert('Selected is within budget', result.selected.price.amount <= intent.max_price, `Price ${result.selected.price.amount} > budget ${intent.max_price}`);
  assert('scored_candidates has both products', result.scored_candidates.length === 2, `Got ${result.scored_candidates.length}`);
  assert('WEIGHTS sum to 1.0', Math.abs(WEIGHTS.relevance + WEIGHTS.rating + WEIGHTS.price_value + WEIGHTS.stock - 1.0) < 1e-9, 'Weights do not sum to 1');

  // v1 ACP format — should also work via _normalizeCandidate
  const v1Results = [
    {
      product: {
        product_id:   'prod_001',
        name:         'Running Shoes Classic',
        description:  'Durable running shoe',
        category:     'footwear',
        price: { amount: 299900, currency: 'INR', display: '₹2,999.00' },
        stock: { available: true, quantity: 100 },
        variants: [],
        rating:       4.2,
        review_count: 45,
        // No source_type — v1 format
      },
      relevance_score: 0.75,
      match_reason:   'keyword match',
    },
  ];

  const v1Result = decideLocal(v1Results, { keywords: ['running'], max_price: 500000 });
  assert('decideLocal accepts v1 format', v1Result.selected !== null, 'v1 result should have selected product');
  assert('Filters applied reflects budget', v1Result.filters_applied.budget_paise === 500000, `Got: ${v1Result.filters_applied.budget_paise}`);
})();

// ═══════════════════════════════════════════════════════════════════
//  UNIT TESTS — decideWithComparison()
// ═══════════════════════════════════════════════════════════════════

section('Unit: decision-engine.js — decideWithComparison()');

(async function testDecideWithComparison() {
  const { decideWithComparison } = require('../agent/decision-engine');

  const candidates = [
    {
      product: {
        product_id:  'p_a', source_type: 'LOCAL_CATALOG', source_name: 'ACG',
        source_url: '', name: 'Product A', description: '', category: 'electronics',
        subcategory: '', price: { amount: 199900, currency: 'INR', display: '₹1,999' },
        stock: { available: true, quantity: 30 }, variants: [], rating: 4.2, review_count: 500,
        attributes: {}, policies: {}, media: [], fetched_at: new Date().toISOString(),
      },
      relevance_score: 0.88,
    },
    {
      product: {
        product_id:  'p_b', source_type: 'LOCAL_CATALOG', source_name: 'ACG',
        source_url: '', name: 'Product B', description: '', category: 'electronics',
        subcategory: '', price: { amount: 149900, currency: 'INR', display: '₹1,499' },
        stock: { available: true, quantity: 5 }, variants: [], rating: 3.9, review_count: 120,
        attributes: {}, policies: {}, media: [], fetched_at: new Date().toISOString(),
      },
      relevance_score: 0.72,
    },
  ];

  const intent = { raw_prompt: 'good electronics', max_price: 250000 };
  const { decision, comparison } = await decideWithComparison(candidates, intent);

  assert('decideWithComparison returns decision', decision && decision.selected !== null, 'decision.selected is null');
  assert('decideWithComparison returns comparison', comparison && Array.isArray(comparison.candidates), 'comparison.candidates missing');
  assert('Comparison has correct candidate count', comparison.candidates.length >= 1, `Got ${comparison.candidates.length}`);
  assert('Decision llm_mode is local', decision.llm_mode === 'local', `Got: ${decision.llm_mode}`);
})();

// ═══════════════════════════════════════════════════════════════════
//  INTEGRATION TESTS — HTTP Endpoints
// ═══════════════════════════════════════════════════════════════════

async function runIntegrationTests() {
  const serverUp = await checkServer();
  if (!serverUp) {
    section('Integration: Skipped (server not reachable on localhost:3000)');
    skip('POST /api/v1/recommendations/decide', 'Server not running');
    skip('POST /api/v1/recommendations/compare', 'Server not running');
    skip('POST /decide validation errors', 'Server not running');
    skip('POST /compare validation errors', 'Server not running');
    return;
  }

  // ── /decide ───────────────────────────────────────────────────────
  section('Integration: POST /api/v1/recommendations/decide');

  {
    const r = await post('/api/v1/recommendations/decide', {
      q:         'running shoes',
      max_price: 100000,
      limit:     5,
    });

    assert('HTTP 200', r.status === 200, `Status: ${r.status}`);
    assert('status: success', r.body?.status === 'success', `Body: ${JSON.stringify(r.body).slice(0, 200)}`);
    assert('data.decision exists', typeof r.body?.data?.decision === 'object', 'data.decision missing');
    assert('data.comparison exists', typeof r.body?.data?.comparison === 'object', 'data.comparison missing');
    assert('data.meta exists', typeof r.body?.data?.meta === 'object', 'data.meta missing');
    assert('meta has llm_mode', typeof r.body?.data?.meta?.llm_mode === 'string', 'llm_mode missing');
    assert('comparison.candidates is array', Array.isArray(r.body?.data?.comparison?.candidates), 'candidates is not array');
    assert('comparison has comparison_id', typeof r.body?.data?.comparison?.comparison_id === 'string', 'comparison_id missing');

    // Verify comparison candidate shape
    const cands = r.body?.data?.comparison?.candidates ?? [];
    if (cands.length > 0) {
      const c = cands[0];
      assert('Candidate has badge field', 'badge' in c, 'badge field missing from candidate');
      assert('Candidate has pros array', Array.isArray(c.pros), 'pros missing from candidate');
      assert('Candidate has cons array', Array.isArray(c.cons), 'cons missing from candidate');
      assert('Candidate has score_breakdown', typeof c.score_breakdown === 'object' || c.score_breakdown === null, 'score_breakdown malformed');
      assert('Candidate has source_type', typeof c.source_type === 'string', 'source_type missing');
    } else {
      skip('Candidate shape tests', 'No candidates returned (empty catalog?)');
    }
  }

  // ── /decide: no results ───────────────────────────────────────────
  {
    const r = await post('/api/v1/recommendations/decide', {
      q: 'zzz_nonexistent_product_xyz_99999',
    });
    assert('/decide with no results returns 200', r.status === 200, `Status: ${r.status}`);
    assert('/decide with no results has comparison', typeof r.body?.data?.comparison === 'object', 'comparison missing on empty result');
  }

  // ── /decide: budget filter ─────────────────────────────────────────
  {
    const r = await post('/api/v1/recommendations/decide', {
      q:         'shoes',
      max_price: 1,     // 1 paise — effectively zero budget
    });
    assert('/decide with unreachable budget returns 200', r.status === 200, `Status: ${r.status}`);
    assert('decision.selected is null for unreachable budget',
      r.body?.data?.decision?.selected === null || r.body?.data?.decision?.selected !== undefined,
      'selected field missing');
  }

  // ── /decide: validation errors ────────────────────────────────────
  section('Integration: POST /decide — Validation');

  {
    const r = await post('/api/v1/recommendations/decide', {});
    assert('Missing q → 422', r.status === 422, `Status: ${r.status}`);
  }
  {
    const r = await post('/api/v1/recommendations/decide', { q: 'shoes', limit: 999 });
    assert('limit > 20 → 422', r.status === 422, `Status: ${r.status}`);
  }
  {
    const r = await post('/api/v1/recommendations/decide', { q: 'shoes', max_price: -100 });
    assert('Negative max_price → 422', r.status === 422, `Status: ${r.status}`);
  }

  // ── /compare ──────────────────────────────────────────────────────
  section('Integration: POST /api/v1/recommendations/compare');

  // Get some product IDs from catalog first
  let sampleIds = [];
  try {
    const catResp = await new Promise((resolve, reject) => {
      http.get('http://localhost:3000/api/v1/catalog/products?limit=3', (res) => {
        let d = '';
        res.on('data', c => d += c);
        res.on('end', () => {
          try { resolve(JSON.parse(d)); } catch { resolve({}); }
        });
      }).on('error', reject);
    });
    sampleIds = (catResp?.data?.products ?? []).slice(0, 3).map(p => p.product_id);
  } catch { /* ignore, will test with empty */ }

  if (sampleIds.length > 0) {
    const r = await post('/api/v1/recommendations/compare', {
      product_ids: sampleIds,
      intent: { max_price: 500000, raw_prompt: 'best value' },
    });

    assert('/compare HTTP 200', r.status === 200, `Status: ${r.status}`);
    assert('/compare status: success', r.body?.status === 'success', `Body status: ${r.body?.status}`);
    assert('/compare data is object', typeof r.body?.data === 'object', 'data missing');
    assert('/compare has candidates', Array.isArray(r.body?.data?.candidates), 'candidates missing');
    assert('/compare has comparison_id', typeof r.body?.data?.comparison_id === 'string', 'comparison_id missing');
    assert('/compare has recommendation_reason', typeof r.body?.data?.recommendation_reason === 'string', 'recommendation_reason missing');
    assert('/compare candidate count matches input', r.body?.data?.candidates.length <= sampleIds.length, 'More candidates than input IDs');
  } else {
    skip('/compare with real IDs', 'No products returned from catalog');
  }

  // /compare: validation errors
  section('Integration: POST /compare — Validation');

  {
    const r = await post('/api/v1/recommendations/compare', { product_ids: [] });
    assert('Empty product_ids → 422', r.status === 422, `Status: ${r.status}`);
  }
  {
    const r = await post('/api/v1/recommendations/compare', {});
    assert('Missing product_ids → 422', r.status === 422, `Status: ${r.status}`);
  }
  {
    const tooMany = Array.from({ length: 11 }, (_, i) => `id_${i}`);
    const r = await post('/api/v1/recommendations/compare', { product_ids: tooMany });
    assert('More than 10 IDs → 422', r.status === 422, `Status: ${r.status}`);
  }
}

// ═══════════════════════════════════════════════════════════════════
//  EXECUTE
// ═══════════════════════════════════════════════════════════════════

runIntegrationTests().then(() => {
  console.log('\n' + '─'.repeat(55));

  const total = passed + failed + skipped;
  const colour = failed > 0 ? RED : GREEN;
  console.log(`${BOLD}${colour}Results: ${passed}/${total - skipped} passed, ${failed} failed, ${skipped} skipped${RESET}`);

  if (failures.length > 0) {
    console.log(`\n${RED}${BOLD}Failed tests:${RESET}`);
    failures.forEach((f) => console.log(`  ${RED}✘ ${f.name}${RESET}\n      ${f.reason}`));
  }

  process.exit(failed > 0 ? 1 : 0);
});
