/**
 * @module agent/catalog-searcher
 * @description Catalog search wrapper for the AI Buyer Agent.
 * 
 * Accepts parsed intent from the intent parser, calls the search_catalog
 * tool against the gateway, and returns structured search results ready
 * for the decision engine.
 * 
 * Handles zero-result scenarios by broadening the search (removing filters).
 * 
 * @see docs/PRD.md Section 5 — F1: Agent-Readable Catalog Service
 */

const searchCatalogTool = require('./tools/search-catalog');

/**
 * Search the merchant catalog using the parsed purchase intent.
 * 
 * Strategy:
 *   1. Search with all filters (keywords + category + max_price)
 *   2. If zero results: retry without max_price filter
 *   3. If still zero: retry with just keywords (no category, no price)
 * 
 * @param {Object} intent - Parsed intent from intent-parser
 * @param {string[]} intent.keywords - Search keywords
 * @param {string|null} intent.category - Category filter
 * @param {number|null} intent.max_price - Max price in paise
 * @param {Object} [options]
 * @param {string} [options.auditTrailId] - Audit trail ID for tracing
 * @param {string} [options.agentId] - Agent ID for tracing
 * @returns {Promise<Object>} Search context: { results, query, search_strategy, attempts }
 */
async function searchCatalog(intent, options = {}) {
  const query = intent.keywords.join(' ');
  const attempts = [];

  // ── Attempt 1: Full-constraint search ──────────────────────────
  const attempt1 = await searchCatalogTool.execute(
    {
      query,
      max_price: intent.max_price || undefined,
      category: intent.category || undefined,
      limit: 10,
    },
    options
  );

  attempts.push({
    strategy: 'full_constraints',
    filters: { query, max_price: intent.max_price, category: intent.category },
    result_count: attempt1.total_matches,
  });

  if (attempt1.total_matches > 0) {
    return {
      results: attempt1.results,
      query: attempt1.query,
      total_matches: attempt1.total_matches,
      search_strategy: 'full_constraints',
      attempts,
    };
  }

  // ── Attempt 2: Remove price filter ─────────────────────────────
  if (intent.max_price) {
    const attempt2 = await searchCatalogTool.execute(
      {
        query,
        category: intent.category || undefined,
        limit: 10,
      },
      options
    );

    attempts.push({
      strategy: 'no_price_filter',
      filters: { query, category: intent.category },
      result_count: attempt2.total_matches,
    });

    if (attempt2.total_matches > 0) {
      return {
        results: attempt2.results,
        query: attempt2.query,
        total_matches: attempt2.total_matches,
        search_strategy: 'no_price_filter',
        attempts,
      };
    }
  }

  // ── Attempt 3: Keywords only (no category, no price) ───────────
  if (intent.category) {
    const attempt3 = await searchCatalogTool.execute(
      {
        query,
        limit: 10,
      },
      options
    );

    attempts.push({
      strategy: 'keywords_only',
      filters: { query },
      result_count: attempt3.total_matches,
    });

    if (attempt3.total_matches > 0) {
      return {
        results: attempt3.results,
        query: attempt3.query,
        total_matches: attempt3.total_matches,
        search_strategy: 'keywords_only',
        attempts,
      };
    }
  }

  // ── No results found ──────────────────────────────────────────
  return {
    results: [],
    query,
    total_matches: 0,
    search_strategy: 'exhausted',
    attempts,
  };
}

module.exports = { searchCatalog };
