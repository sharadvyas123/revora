/**
 * @module agent/comparison-engine
 * @description Product Comparison Engine for the Agentic Commerce Gateway v2.
 *
 * Accepts scored candidates (unified Normalized Product Schema) and produces:
 *  - A side-by-side comparison matrix with pros/cons for each candidate.
 *  - Dynamic badges: "Best Overall Match" | "Best Value" | "Highest Rated"
 *  - A top recommendation with natural-language justification.
 *
 * This module is source-agnostic — it handles both LOCAL_CATALOG and
 * EXTERNAL_WEB products equally via the shared Normalized Product Schema.
 *
 * @see docs/TRD.md Section 3.2 — Product Comparison Matrix Output
 * @see docs/ticket_02_recommendation_and_comparison.md Section 2.2
 */

const { v4: uuidv4 } = require('uuid');

// ── Badge Labels ────────────────────────────────────────────────────
const BADGE_BEST_OVERALL  = 'Best Overall Match';
const BADGE_BEST_VALUE    = 'Best Value';
const BADGE_HIGHEST_RATED = 'Highest Rated';
const BADGE_NONE          = null;

// Minimum rating to be considered for "Best Value" badge
const BEST_VALUE_RATING_FLOOR = 3.5;

// ── ComparisonEngine ────────────────────────────────────────────────

/**
 * Generate a full side-by-side product comparison matrix.
 *
 * @param {Object[]} scoredCandidates - Array from decision-engine:
 *   each element is { product, scores: { composite, relevance, rating, price_value, stock }, relevance_score }
 * @param {Object} intent - Parsed user intent { keywords, max_price, category, raw_prompt }
 * @returns {Object} Comparison result in TRD §3.2 format
 */
function compare(scoredCandidates, intent = {}) {
  if (!scoredCandidates || scoredCandidates.length === 0) {
    return {
      comparison_id:         `cmp_${uuidv4().replace(/-/g, '').slice(0, 12)}`,
      query:                 intent.raw_prompt || '',
      recommended_product_id: null,
      recommendation_reason:  'No candidates available to compare.',
      candidates:            [],
      generated_at:          new Date().toISOString(),
    };
  }

  // Sort by composite score descending for matrix ordering
  const sorted = [...scoredCandidates].sort(
    (a, b) => (b.scores?.composite ?? 0) - (a.scores?.composite ?? 0)
  );

  // Identify badge winners
  const bestOverall = sorted[0];

  const eligibleForValue = sorted.filter(
    (c) => (c.product.stock?.available !== false) &&
            (c.product.rating == null || c.product.rating >= BEST_VALUE_RATING_FLOOR)
  );
  const bestValue = eligibleForValue.length > 0
    ? eligibleForValue.reduce((a, b) =>
        a.product.price.amount <= b.product.price.amount ? a : b
      )
    : null;

  const highestRated = sorted.reduce((a, b) =>
    (b.product.rating ?? 0) > (a.product.rating ?? 0) ? b : a
  );

  // Build candidate comparison entries
  const candidates = sorted.map((c) => {
    const p = c.product;
    const badge = _assignBadge(c, bestOverall, bestValue, highestRated);
    const { pros, cons } = _generateProscons(c, sorted, intent);

    return {
      product_id:   p.product_id,
      name:         p.name,
      source_type:  p.source_type,
      source_name:  p.source_name,
      source_url:   p.source_url,
      price:        p.price.amount,
      price_display: p.price.display,
      rating:       p.rating ?? null,
      review_count: p.review_count ?? 0,
      in_stock:     p.stock?.available ?? true,
      stock_qty:    p.stock?.quantity  ?? null,
      score:        Math.round((c.scores?.composite ?? 0) * 1000) / 1000,
      score_breakdown: c.scores
        ? {
            relevance:   c.scores.relevance,
            rating:      c.scores.rating,
            price_value: c.scores.price_value,
            stock:       c.scores.stock,
          }
        : null,
      badge,
      pros,
      cons,
    };
  });

  // Build recommendation reason for top pick
  const top = sorted[0];
  const reason = _buildRecommendationReason(top, intent, sorted);

  return {
    comparison_id:          `cmp_${uuidv4().replace(/-/g, '').slice(0, 12)}`,
    query:                  intent.raw_prompt || (intent.keywords?.join(' ') ?? ''),
    recommended_product_id: top.product.product_id,
    recommendation_reason:  reason,
    candidates,
    generated_at:           new Date().toISOString(),
  };
}

// ── Private Helpers ─────────────────────────────────────────────────

/**
 * Assign the most appropriate badge to a candidate.
 * A product can only hold one badge (priority: Best Overall > Best Value > Highest Rated).
 * @private
 */
function _assignBadge(candidate, bestOverall, bestValue, highestRated) {
  if (candidate === bestOverall) return BADGE_BEST_OVERALL;
  if (bestValue && candidate === bestValue) return BADGE_BEST_VALUE;
  if (candidate === highestRated && (highestRated !== bestOverall)) return BADGE_HIGHEST_RATED;
  return BADGE_NONE;
}

/**
 * Generate pros and cons for a candidate relative to others in the set.
 * @private
 */
function _generateProscons(candidate, allSorted, intent) {
  const p   = candidate.product;
  const avg = _average(allSorted.map(c => c.product.price.amount));
  const pros = [];
  const cons = [];

  // Price
  if (p.price.amount < avg * 0.9) {
    pros.push(`Priced below average (${p.price.display})`);
  } else if (p.price.amount > avg * 1.15) {
    cons.push(`Higher price than average (${p.price.display})`);
  }

  // Rating
  if (p.rating != null) {
    if (p.rating >= 4.5) pros.push(`Excellent rating: ${p.rating}★`);
    else if (p.rating >= 4.0) pros.push(`Good rating: ${p.rating}★`);
    else if (p.rating < 3.5) cons.push(`Below-average rating: ${p.rating}★`);
  } else {
    cons.push('No rating data available');
  }

  // Review count — social proof signal
  if ((p.review_count ?? 0) >= 1000) pros.push(`Well-reviewed: ${p.review_count.toLocaleString()} reviews`);
  else if ((p.review_count ?? 0) < 50) cons.push('Limited reviews');

  // Stock
  if (p.stock?.available === false) {
    cons.push('Out of stock');
  } else if (p.stock?.quantity != null && p.stock.quantity <= 5) {
    cons.push(`Low stock: only ${p.stock.quantity} units left`);
  } else if (p.stock?.quantity != null && p.stock.quantity > 20) {
    pros.push(`Good stock availability: ${p.stock.quantity} units`);
  }

  // Return/warranty policies
  const returnDays = p.policies?.return_window_days;
  if (returnDays != null && returnDays >= 30) pros.push(`${returnDays}-day return policy`);
  else if (returnDays != null && returnDays < 15) cons.push(`Short return window: ${returnDays} days`);

  const warranty = p.policies?.warranty_months;
  if (warranty != null && warranty >= 12) pros.push(`${warranty}-month warranty`);

  // Source badge
  if (p.source_type === 'LOCAL_CATALOG') pros.push('Available from local merchant (fast checkout)');

  // Budget headroom
  if (intent.max_price && p.price.amount <= intent.max_price) {
    const headroom = intent.max_price - p.price.amount;
    if (headroom > 0) pros.push(`₹${(headroom / 100).toLocaleString('en-IN')} under your budget`);
  }

  return { pros, cons };
}

/**
 * Build a natural-language recommendation reason for the top-ranked product.
 * @private
 */
function _buildRecommendationReason(top, intent, allSorted) {
  const p     = top.product;
  const score = Math.round((top.scores?.composite ?? 0) * 100);
  const parts = [];

  parts.push(`"${p.name}" is the top-ranked candidate with a composite match score of ${score}%.`);

  if (p.rating) parts.push(`It carries a ${p.rating}★ rating from ${(p.review_count ?? 0).toLocaleString()} reviewers.`);

  if (intent.max_price && p.price.amount <= intent.max_price) {
    const savings = intent.max_price - p.price.amount;
    parts.push(
      `At ${p.price.display}, it sits ${savings > 0
        ? `₹${(savings / 100).toLocaleString('en-IN')} under the stated budget`
        : 'exactly at the budget ceiling'}.`
    );
  } else {
    parts.push(`It is priced at ${p.price.display}.`);
  }

  const runner_up = allSorted[1];
  if (runner_up) {
    const rp = runner_up.product;
    const diff = Math.round(((top.scores?.composite ?? 0) - (runner_up.scores?.composite ?? 0)) * 100);
    parts.push(
      `The next best alternative is "${rp.name}" (${rp.price.display}), scoring ${diff} point${diff !== 1 ? 's' : ''} lower.`
    );
  }

  return parts.join(' ');
}

/**
 * Compute the arithmetic mean of a number array.
 * @private
 */
function _average(arr) {
  if (!arr.length) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

module.exports = { compare };
