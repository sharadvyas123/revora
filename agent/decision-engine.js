/**
 * @module agent/decision-engine
 * @description Dual-mode product selection engine for the AI Buyer Agent.
 *
 * v2 Update: Now source-agnostic — processes both:
 *   - v1 catalog rows: { product, relevance_score, match_reason } where product is
 *     the ACP Product Feed format from CatalogService._formatProduct().
 *   - v2 discovery rows: { product, relevance_score, match_source } where product is
 *     the unified Normalized Product Schema from NormalizerService.
 *
 * Both are normalized via _normalizeCandidate() before scoring.
 *
 * Mode 1 — Gemini LLM (when GEMINI_API_KEY is set):
 *   Uses Google Gemini to reason holistically about which product best serves intent.
 *
 * Mode 2 — Local Weighted Scoring (deterministic fallback):
 *   Composite: (0.4 × relevance) + (0.3 × rating) + (0.2 × price_value) + (0.1 × stock)
 *
 * @see agent/comparison-engine.js — Side-by-side comparison matrix
 * @see docs/TRD.md Section 3.1 — Candidate Scoring Function
 */

require('dotenv').config();
const { isAvailable, decideWithGemini } = require('./gemini-llm');
const { compare } = require('./comparison-engine');

// ── Local Scoring Weights ───────────────────────────────────────────────
const WEIGHTS = { relevance: 0.40, rating: 0.30, price_value: 0.20, stock: 0.10 };

// ═══════════════════════════════════════════════════════════════════
//  SOURCE-AGNOSTIC ADAPTER
// ═══════════════════════════════════════════════════════════════════

/**
 * Normalize a single candidate entry into a consistent shape, regardless of
 * whether it originates from the v1 CatalogService or the v2 DiscoveryService.
 *
 * Input variants:
 *   v1: { product: ACPFormat, relevance_score, match_reason }
 *   v2: { product: NormalizedSchema, relevance_score, match_source }
 *
 * Output: { product, relevance_score } where product always has:
 *   product_id, name, price.{amount, display}, rating, review_count,
 *   stock.{available, quantity}, variants, policies
 *
 * @param {Object} entry - Raw candidate from search or discovery
 * @returns {Object} Normalized candidate
 * @private
 */
function _normalizeCandidate(entry) {
  const p = entry.product;

  // If already in Normalized Product Schema (has source_type), pass through
  if (p.source_type) return entry;

  // v1 ACP format: price is { amount, currency, display }, stock is { available, quantity }
  // These match the normalized schema already — just ensure key fields exist.
  return {
    ...entry,
    product: {
      product_id:   p.product_id,
      source_type:  'LOCAL_CATALOG',
      source_name:  'ACG Local Catalog',
      source_url:   `http://localhost:3000/api/v1/catalog/products/${p.product_id}`,
      name:         p.name,
      description:  p.description || '',
      category:     p.category    || '',
      subcategory:  p.subcategory || '',
      price:        p.price,
      stock:        p.stock,
      variants:     p.variants    || [],
      rating:       p.rating      ?? null,
      review_count: p.review_count ?? 0,
      attributes:   p.attributes  || {},
      policies:     p.policies    || {},
      media:        p.media       || [],
      merchant_id:  p.merchant_id || null,
      fetched_at:   p.updated_at  || new Date().toISOString(),
    },
  };
}

// ═══════════════════════════════════════════════════════════════════
//  PUBLIC API
// ═══════════════════════════════════════════════════════════════════

/**
 * Evaluate search/discovery results and select the best product.
 *
 * Automatically uses Gemini LLM if GEMINI_API_KEY is set, otherwise
 * falls back to the local weighted scoring engine.
 *
 * @param {Object[]} searchResults - Array of { product, relevance_score, match_reason|match_source }
 *   Accepts both v1 CatalogService format and v2 DiscoveryService format.
 * @param {Object} intent - Parsed purchase intent
 * @returns {Promise<Object>} Decision result:
 *   { selected, alternatives, filters_applied, scored_candidates, reasoning, llm_mode }
 */
async function decide(searchResults, intent) {
  // Normalize all candidates to unified schema first
  const normalizedResults = (searchResults || []).map(_normalizeCandidate);

  if (isAvailable()) {
    try {
      const result = await decideWithGemini(normalizedResults, intent);
      return { ...result, llm_mode: 'gemini' };
    } catch (err) {
      console.warn(`  ⚠ Gemini decision failed (${err.message}), falling back to local scoring`);
    }
  }

  return decideLocal(normalizedResults, intent);
}

/**
 * decide() + comparison matrix in one call.
 * Used by the RecommendationService and agent tooling.
 *
 * @param {Object[]} searchResults - Raw search/discovery candidates
 * @param {Object} intent - Parsed intent with budget, category, keywords
 * @returns {Promise<Object>} { decision, comparison }
 */
async function decideWithComparison(searchResults, intent) {
  const normalizedResults = (searchResults || []).map(_normalizeCandidate);
  const decision = await decide(normalizedResults, intent);

  // Build scored candidates array for comparison engine
  // decision.scored_candidates has composite scores; re-attach product objects
  const scoredForComparison = (decision.scored_candidates || []).map((sc) => {
    const match = normalizedResults.find((r) => r.product.product_id === sc.product_id);
    return match
      ? {
          product: match.product,
          relevance_score: match.relevance_score,
          scores: {
            composite:   sc.composite_score,
            relevance:   match.relevance_score,
            rating:      sc.composite_score, // approximation when granular scores unavailable
            price_value: sc.composite_score,
            stock:       sc.composite_score,
          },
        }
      : null;
  }).filter(Boolean);

  const comparison = compare(scoredForComparison, intent);
  return { decision, comparison };
}

// ════════════════════════════════════════════════════════════════════
//  LOCAL WEIGHTED SCORING ENGINE (deterministic fallback)
// ════════════════════════════════════════════════════════════════════

/**
 * Local deterministic decision engine using composite weighted scoring.
 * @param {Object[]} searchResults
 * @param {Object} intent
 * @returns {Object} Decision result with llm_mode: 'local'
 */
function decideLocal(searchResults, intent) {
  if (!searchResults || searchResults.length === 0) {
    return {
      selected: null,
      alternatives: [],
      filters_applied: buildFiltersApplied(intent),
      scored_candidates: [],
      reasoning: 'No products found matching the search criteria.',
      llm_mode: 'local',
    };
  }

  // Filter by budget
  const withinBudget = intent.max_price
    ? searchResults.filter(r => r.product.price.amount <= intent.max_price)
    : [...searchResults];

  const overBudget = intent.max_price
    ? searchResults.filter(r => r.product.price.amount > intent.max_price)
    : [];

  if (withinBudget.length === 0) {
    const cheapest = [...searchResults].sort((a, b) => a.product.price.amount - b.product.price.amount)[0];
    return {
      selected: null,
      alternatives: searchResults.map(r => ({
        product_id: r.product.product_id,
        name: r.product.name,
        price: r.product.price,
        reason: `Exceeds budget (${r.product.price.display} > ${formatPrice(intent.max_price)})`,
      })),
      filters_applied: buildFiltersApplied(intent),
      scored_candidates: [],
      reasoning: `All ${searchResults.length} results exceed the budget. Cheapest: ${cheapest.product.name} at ${cheapest.product.price.display}.`,
      llm_mode: 'local',
    };
  }

  // Normalize scoring ranges
  const maxPrice = Math.max(...withinBudget.map(r => r.product.price.amount));
  const minPrice = Math.min(...withinBudget.map(r => r.product.price.amount));
  const priceRange = maxPrice - minPrice || 1;
  const maxRating = Math.max(...withinBudget.map(r => r.product.rating || 0));
  const minRating = Math.min(...withinBudget.map(r => r.product.rating || 0));
  const ratingRange = maxRating - minRating || 1;

  const scoredCandidates = withinBudget.map(r => {
    const relevanceScore  = r.relevance_score || 0;
    const ratingScore     = r.product.rating ? (r.product.rating - minRating) / ratingRange : 0;
    const priceValueScore = 1 - ((r.product.price.amount - minPrice) / priceRange);
    const stockScore      = Math.min((r.product.stock.quantity || 0) / 50, 1.0);
    const compositeScore  =
      WEIGHTS.relevance   * relevanceScore  +
      WEIGHTS.rating      * ratingScore     +
      WEIGHTS.price_value * priceValueScore +
      WEIGHTS.stock       * stockScore;

    return {
      product: r.product,
      relevance_score: relevanceScore,
      match_reason: r.match_reason,
      scores: {
        relevance:    round(relevanceScore),
        rating:       round(ratingScore),
        price_value:  round(priceValueScore),
        stock:        round(stockScore),
        composite:    round(compositeScore),
      },
    };
  });

  scoredCandidates.sort((a, b) => b.scores.composite - a.scores.composite);

  const winner = scoredCandidates[0];
  const alternatives = scoredCandidates.slice(1).map(alt => ({
    product_id:      alt.product.product_id,
    name:            alt.product.name,
    price:           alt.product.price,
    composite_score: alt.scores.composite,
    reason:          buildAlternativeReason(alt, winner),
  }));

  // Include over-budget items as explicitly rejected
  const rejectedAlternatives = overBudget.map(r => ({
    product_id:      r.product.product_id,
    name:            r.product.name,
    price:           r.product.price,
    composite_score: 0,
    reason:          `Rejected: exceeds budget (${r.product.price.display} > ${formatPrice(intent.max_price)})`,
  }));

  const selectionReason = buildSelectionReason(winner, intent);

  return {
    selected: {
      product_id:      winner.product.product_id,
      name:            winner.product.name,
      price:           winner.product.price,
      variant_id:      selectBestVariant(winner.product),
      composite_score: winner.scores.composite,
      scores:          winner.scores,
      reason:          selectionReason,
    },
    alternatives:      [...alternatives, ...rejectedAlternatives],
    filters_applied:   buildFiltersApplied(intent),
    scored_candidates: scoredCandidates.map(c => ({
      product_id:      c.product.product_id,
      name:            c.product.name,
      price_display:   c.product.price.display,
      composite_score: c.scores.composite,
    })),
    reasoning:  selectionReason,
    llm_mode:  'local',
  };
}

// ── Private Helpers ─────────────────────────────────────────────────

function selectBestVariant(product) {
  if (!product.variants || product.variants.length === 0) return null;
  const available = product.variants
    .filter(v => v.stock.available && v.stock.quantity > 0)
    .sort((a, b) => b.stock.quantity - a.stock.quantity);
  return available.length > 0 ? available[0].variant_id : product.variants[0].variant_id;
}

function buildSelectionReason(winner, intent) {
  const p = winner.product;
  const parts = [`Selected "${p.name}" (${p.price.display})`];
  if (p.rating) parts.push(`rated ${p.rating}★ with ${p.review_count} reviews`);
  if (intent.max_price) {
    const savings = intent.max_price - p.price.amount;
    if (savings > 0) parts.push(`₹${(savings / 100).toLocaleString('en-IN')} under budget`);
  }
  parts.push(`${p.stock.quantity} units in stock`);
  return parts.join('. ') + '.';
}

function buildAlternativeReason(alt, winner) {
  const parts = [];
  const diff = round(winner.scores.composite - alt.scores.composite);
  if (diff > 0) parts.push(`Lower composite score by ${diff}`);
  if (alt.product.rating && winner.product.rating && alt.product.rating < winner.product.rating)
    parts.push(`Lower rating (${alt.product.rating}★ vs ${winner.product.rating}★)`);
  if (alt.product.price.amount > winner.product.price.amount)
    parts.push(`Higher price (${alt.product.price.display})`);
  return parts.length > 0 ? parts.join('. ') + '.' : 'Ranked lower by composite score.';
}

function buildFiltersApplied(intent) {
  return {
    budget:       intent.max_price ? formatPrice(intent.max_price) : 'none',
    budget_paise: intent.max_price,
    category:     intent.category || 'any',
    keywords:     intent.keywords,
    raw_prompt:   intent.raw_prompt,
  };
}

function formatPrice(paise) {
  return `₹${(paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;
}

function round(n) { return Math.round(n * 1000) / 1000; }

module.exports = { decide, decideWithComparison, WEIGHTS, decideLocal };
