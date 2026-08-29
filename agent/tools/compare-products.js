/**
 * @module agent/tools/compare-products
 * @description LLM function-calling tool for side-by-side product comparison.
 *
 * Calls POST /api/v1/recommendations/compare on the gateway, which returns
 * a structured comparison matrix covering price, rating, stock, policies,
 * and a composite score for each product.
 *
 * Use this after narrowing the product list to 2–5 candidates to give
 * the user a clear, fact-based view before the final selection.
 *
 * @see docs/TRD.md Section 3.3 — Product Comparison Matrix
 */

const BASE_URL = process.env.GATEWAY_URL || 'http://localhost:3000';

/**
 * Tool schema for compare_products — used by the LLM function-calling layer.
 */
const compareProductsTool = {
  name: 'compare_products',
  description: 'Generate a side-by-side comparison matrix for 2–10 products. Returns structured attributes, pricing, rating, stock, policies, and composite scores for each product. Use this to help the user make an informed final choice.',
  parameters: {
    type: 'object',
    properties: {
      product_ids: {
        type: 'array',
        description: 'List of product IDs to compare (2–10 products)',
        items: { type: 'string' },
        minItems: 1,
        maxItems: 10,
      },
      intent: {
        type: 'object',
        description: 'Optional search intent context to weight the comparison scoring',
        properties: {
          query: { type: 'string', description: 'Original search query' },
          max_price: { type: 'integer', description: 'Budget ceiling in paise' },
          category: { type: 'string', description: 'Preferred category' },
        },
      },
    },
    required: ['product_ids'],
  },

  /**
   * Execute the product comparison.
   *
   * @param {Object} args
   * @param {string[]} args.product_ids - Product IDs to compare
   * @param {Object} [args.intent] - Intent context for scoring
   * @param {Object} [options]
   * @param {string} [options.agentId] - Agent ID for headers
   * @returns {Promise<Object>} { products[], comparison_matrix, winner, reasoning }
   */
  async execute(args, options = {}) {
    const headers = { 'Content-Type': 'application/json' };
    if (options.agentId) headers['x-agent-id'] = options.agentId;

    const url = `${BASE_URL}/api/v1/recommendations/compare`;
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        product_ids: args.product_ids,
        intent: args.intent || {},
      }),
    });
    const json = await res.json();

    if (json.status !== 'success') {
      throw new Error(`compare_products failed: ${json.message || JSON.stringify(json)}`);
    }

    return json.data;
  },
};

module.exports = compareProductsTool;
