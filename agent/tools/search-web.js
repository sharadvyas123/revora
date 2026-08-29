/**
 * @module agent/tools/search-web
 * @description LLM function-calling tool for multi-source product discovery.
 *
 * Calls GET /api/v1/discovery/search on the gateway, which merges results
 * from the local merchant catalog AND external web sources into a unified
 * normalized format.
 *
 * Use this when the catalog search returns insufficient results or the user
 * explicitly wants to see options beyond the main merchant's inventory.
 *
 * @see docs/TRD.md Section 3.4 — Discovery Pipeline
 */

const BASE_URL = process.env.GATEWAY_URL || 'http://localhost:3000';

/**
 * Tool schema for search_web — used by the LLM function-calling layer.
 */
const searchWebTool = {
  name: 'search_web',
  description: 'Search for products across multiple sources including the merchant catalog and external web. Returns normalized, ranked results from all available sources. Use when you want broader discovery beyond the local catalog.',
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Search keywords (e.g. "running shoes", "lightweight trail runners")',
      },
      category: {
        type: 'string',
        description: 'Filter by product category (e.g. "footwear", "apparel", "electronics")',
      },
      max_price: {
        type: 'integer',
        description: 'Maximum price in paise (₹1 = 100 paise). E.g. 300000 for ₹3,000',
      },
      limit: {
        type: 'integer',
        description: 'Max number of results to return (default: 10, max: 50)',
      },
    },
    required: ['query'],
  },

  /**
   * Execute the multi-source discovery search.
   *
   * @param {Object} args
   * @param {string} args.query - Search keywords
   * @param {string} [args.category] - Category filter
   * @param {number} [args.max_price] - Max price in paise
   * @param {number} [args.limit=10] - Max results
   * @param {Object} [options]
   * @param {string} [options.agentId] - Agent ID for headers
   * @returns {Promise<Object>} { query, filters, total_found, results[], sources_queried[] }
   */
  async execute(args, options = {}) {
    const params = new URLSearchParams();
    params.set('q', args.query);
    if (args.category) params.set('category', args.category);
    if (args.max_price) params.set('max_price', args.max_price.toString());
    if (args.limit) params.set('limit', args.limit.toString());

    const headers = { 'Content-Type': 'application/json' };
    if (options.agentId) headers['x-agent-id'] = options.agentId;

    const url = `${BASE_URL}/api/v1/discovery/search?${params.toString()}`;
    const res = await fetch(url, { headers });
    const json = await res.json();

    if (json.status !== 'success') {
      throw new Error(`search_web failed: ${json.message || JSON.stringify(json)}`);
    }

    return json.data;
  },
};

module.exports = searchWebTool;
