/**
 * @module gateway/services/recommendation.service
 * @description Recommendation Service for the Agentic Commerce Gateway v2.
 *
 * Orchestrates the full recommendation pipeline:
 *  1. Calls DiscoveryService to get multi-source candidates.
 *  2. Runs the DecisionEngine (local or Gemini-backed) to score and rank.
 *  3. Calls the ComparisonEngine to produce a side-by-side matrix.
 *
 * Exposes two primary operations:
 *  - recommend({ q, max_price, category, limit }) → decision + comparison
 *  - compare({ product_ids, intent })            → comparison matrix only
 *
 * @see agent/decision-engine.js
 * @see agent/comparison-engine.js
 * @see docs/TRD.md Section 3 — Recommendation & Product Comparison Algorithms
 * @see docs/ticket_02_recommendation_and_comparison.md
 */

const { decideWithComparison } = require('../../agent/decision-engine');
const { compare }              = require('../../agent/comparison-engine');
const logger                   = require('../../lib/logger');

class RecommendationService {
  /**
   * @param {import('better-sqlite3').Database} db              - SQLite connection
   * @param {import('./discovery.service')} discoveryService    - Multi-source discovery
   * @param {import('./catalog.service')}   catalogService      - v1 local catalog fallback
   */
  constructor(db, discoveryService, catalogService) {
    this.db               = db;
    this.discoveryService = discoveryService;
    this.catalogService   = catalogService;
  }

  // ── Public API ───────────────────────────────────────────────────

  /**
   * Full recommendation pipeline: discover → score → compare → explain.
   *
   * @param {Object} params
   * @param {string}  params.q          - Search query (required)
   * @param {number}  [params.max_price] - Budget ceiling in paise
   * @param {string}  [params.category]  - Category filter
   * @param {number}  [params.limit=10]  - Max candidates to consider
   * @param {boolean} [params.local_only=false] - Skip external web
   * @returns {Promise<Object>} { decision, comparison, meta }
   */
  async recommend({ q, max_price, category, limit = 10, local_only = false }) {
    logger.info('[RecommendationService] recommend', { q, max_price, category, limit });

    // Step 1: Discover candidates across local + external sources
    const discoveryResult = this.discoveryService.search({
      q, max_price, category, limit, local_only,
    });

    // Map discovery results into the shape expected by decision-engine:
    // { product, relevance_score, match_source }
    const candidates = discoveryResult.results;

    // Step 2+3: Score, rank, and compare in one pass
    const intent = {
      raw_prompt: q,
      keywords:   q.split(/\s+/).filter(Boolean),
      max_price:  max_price ?? null,
      category:   category  ?? null,
    };

    const { decision, comparison } = await decideWithComparison(candidates, intent);

    logger.info('[RecommendationService] recommend complete', {
      q,
      candidates_found: candidates.length,
      selected: decision.selected?.product_id ?? null,
      llm_mode: decision.llm_mode,
    });

    return {
      decision,
      comparison,
      meta: {
        query:           q,
        sources_queried: discoveryResult.sources_queried,
        total_discovered: discoveryResult.total_found,
        candidates_scored: candidates.length,
        llm_mode: decision.llm_mode,
      },
    };
  }

  /**
   * Generate a comparison matrix for a specific list of known product IDs
   * (already discovered or selected by the user).
   *
   * Fetches full product details from the local catalog and wraps them in the
   * normalized schema, then runs the comparison engine.
   *
   * @param {Object} params
   * @param {string[]} params.product_ids  - List of product_id strings
   * @param {Object}   [params.intent={}]  - Optional intent for budget-aware scoring
   * @returns {Promise<Object>} Comparison matrix payload
   */
  async compareById({ product_ids, intent = {} }) {
    logger.info('[RecommendationService] compareById', { product_ids });

    if (!product_ids || product_ids.length === 0) {
      return {
        comparison_id: null,
        candidates: [],
        recommendation_reason: 'No product IDs provided.',
      };
    }

    // Fetch each product from local catalog (external products are already normalized)
    const candidates = product_ids.map((pid) => {
      // Try local catalog first
      const row = this.db.prepare('SELECT * FROM products WHERE product_id = ?').get(pid);
      if (row) {
        const variants = this.db.prepare('SELECT * FROM variants WHERE product_id = ?').all(pid);
        const normalized = this._normalizeLocalRow(row, variants);
        return {
          product: normalized,
          relevance_score: intent.max_price
            ? Math.max(0, 1 - (row.price_amount / intent.max_price))
            : 0.5,
        };
      }

      // Try external products cache
      const ext = this.db.prepare('SELECT * FROM external_products WHERE external_id = ?').get(pid);
      if (ext) {
        const payload = this._safeParseJSON(ext.normalized_payload, {});
        return {
          product: {
            product_id:   ext.external_id,
            source_type:  'EXTERNAL_WEB',
            source_name:  ext.source_name,
            source_url:   ext.source_url,
            name:         payload.name        || '',
            description:  payload.description || '',
            category:     payload.category    || '',
            subcategory:  payload.subcategory || '',
            price:        payload.price       || { amount: 0, currency: 'INR', display: '₹0.00' },
            stock:        payload.stock       || { available: true, quantity: null },
            variants:     [],
            rating:       payload.rating       ?? null,
            review_count: payload.review_count ?? 0,
            attributes:   payload.attributes   || {},
            policies:     payload.policies     || {},
            media:        payload.media        || [],
            merchant_id:  null,
            fetched_at:   ext.fetched_at,
          },
          relevance_score: 0.5,
        };
      }

      return null;
    }).filter(Boolean);

    // Attach synthetic scores based on rating and price_value
    const maxPrice = candidates.length > 0
      ? Math.max(...candidates.map(c => c.product.price.amount))
      : 1;

    const scoredCandidates = candidates.map((c) => {
      const ratingScore    = (c.product.rating ?? 3.5) / 5.0;
      const priceValueScore = intent.max_price
        ? Math.max(0, (intent.max_price - c.product.price.amount) / intent.max_price)
        : (maxPrice > 0 ? 1 - c.product.price.amount / maxPrice : 0.5);
      const stockScore     = c.product.stock?.available !== false ? 1.0 : 0.0;
      const composite = 0.40 * c.relevance_score + 0.30 * ratingScore + 0.20 * priceValueScore + 0.10 * stockScore;

      return {
        product: c.product,
        relevance_score: c.relevance_score,
        scores: {
          composite:   Math.round(composite   * 1000) / 1000,
          relevance:   Math.round(c.relevance_score * 1000) / 1000,
          rating:      Math.round(ratingScore  * 1000) / 1000,
          price_value: Math.round(priceValueScore * 1000) / 1000,
          stock:       stockScore,
        },
      };
    });

    return compare(scoredCandidates, intent);
  }

  // ── Private Helpers ──────────────────────────────────────────────

  _normalizeLocalRow(row, variants = []) {
    const formattedVariants = variants.map((v) => ({
      variant_id:    v.variant_id,
      attributes:    this._safeParseJSON(v.attributes, {}),
      price_override: v.price_override ?? null,
      stock: { available: v.stock_available === 1, quantity: v.stock_quantity },
    }));

    return {
      product_id:   row.product_id,
      source_type:  'LOCAL_CATALOG',
      source_name:  'ACG Local Catalog',
      source_url:   `http://localhost:3000/api/v1/catalog/products/${row.product_id}`,
      name:         row.name,
      description:  row.description || '',
      category:     row.category    || '',
      subcategory:  row.subcategory || '',
      price: {
        amount:   row.price_amount,
        currency: row.price_currency || 'INR',
        display:  `₹${(row.price_amount / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`,
      },
      stock: {
        available:           row.stock_available === 1,
        quantity:            row.stock_quantity,
        low_stock_threshold: row.low_stock_threshold ?? null,
      },
      variants:     formattedVariants,
      rating:       row.rating      ?? null,
      review_count: row.review_count ?? 0,
      attributes:   {},
      policies:     this._safeParseJSON(row.policies, {}),
      media:        this._safeParseJSON(row.media, []),
      merchant_id:  row.merchant_id || null,
      fetched_at:   row.updated_at  || new Date().toISOString(),
    };
  }

  _safeParseJSON(jsonStr, fallback) {
    if (!jsonStr) return fallback;
    try { return JSON.parse(jsonStr); } catch { return fallback; }
  }
}

module.exports = RecommendationService;
