/**
 * @module agent/tools/search-catalog
 * @description LLM function-calling tool definition for catalog search.
 * 
 * Calls GET /api/v1/catalog/search on the gateway to discover products
 * matching the agent's query, with optional price and category filters.
 * 
 * Follows the OpenAI function-calling JSON Schema pattern:
 *   { name, description, parameters, execute(args) }
 * 
 * @see docs/TRD.md Section 3.1 — Catalog API
 */

const BASE_URL = process.env.GATEWAY_URL || 'http://localhost:3000';

/**
 * Tool schema for search_catalog — used by the LLM function-calling layer.
 */
const searchCatalogTool = {
  name: 'search_catalog',
  description: 'Search the merchant catalog for products matching a keyword query. Returns ranked results with relevance scores. Only returns in-stock products.',
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Search keywords (e.g. "running shoes", "wireless earbuds")',
      },
      max_price: {
        type: 'integer',
        description: 'Maximum price in paise (₹1 = 100 paise). E.g. 300000 for ₹3,000',
      },
      category: {
        type: 'string',
        description: 'Filter by product category (e.g. "footwear", "apparel", "electronics")',
      },
      limit: {
        type: 'integer',
        description: 'Maximum number of results to return (default: 10, max: 50)',
      },
    },
    required: ['query'],
  },

  /**
   * Execute the catalog search against the gateway API.
   * 
   * @param {Object} args
   * @param {string} args.query - Search keywords
   * @param {number} [args.max_price] - Max price in paise
   * @param {string} [args.category] - Category filter
   * @param {number} [args.limit=10] - Max results
   * @param {Object} [options]
   * @param {string} [options.auditTrailId] - Audit trail ID to attach as header
   * @param {string} [options.agentId] - Agent ID to attach as header
   * @returns {Promise<Object>} Search results: { query, results[], total_matches }
   */
  async execute(args, options = {}) {
    const params = new URLSearchParams();
    params.set('q', args.query);
    if (args.max_price) params.set('max_price', args.max_price.toString());
    if (args.category) params.set('category', args.category);
    if (args.limit) params.set('limit', args.limit.toString());

    const headers = { 'Content-Type': 'application/json' };
    if (options.auditTrailId) headers['X-Audit-Trail-Id'] = options.auditTrailId;
    if (options.agentId) headers['X-Agent-Id'] = options.agentId;

    const url = `${BASE_URL}/api/v1/catalog/search?${params.toString()}`;
    const res = await fetch(url, { headers });
    const json = await res.json();

    if (json.status !== 'success') {
      throw new Error(`search_catalog failed: ${json.message || JSON.stringify(json)}`);
    }

    return json.data;
  },
};

module.exports = searchCatalogTool;
