/**
 * @module agent/tools/get-product
 * @description LLM function-calling tool definition for product detail retrieval.
 * 
 * Calls GET /api/v1/catalog/products/:id on the gateway to fetch full
 * product details including all variants, pricing, stock, and policies.
 * 
 * @see docs/TRD.md Section 3.1 — Catalog API
 */

const BASE_URL = process.env.GATEWAY_URL || 'http://localhost:3000';

/**
 * Tool schema for get_product — used by the LLM function-calling layer.
 */
const getProductTool = {
  name: 'get_product',
  description: 'Get full product details by product ID. Returns pricing, stock, all variants, policies, and media.',
  parameters: {
    type: 'object',
    properties: {
      product_id: {
        type: 'string',
        description: 'The product ID to look up (e.g. "prod_nike_pegasus")',
      },
    },
    required: ['product_id'],
  },

  /**
   * Execute the product detail lookup against the gateway API.
   * 
   * @param {Object} args
   * @param {string} args.product_id - Product ID to retrieve
   * @returns {Promise<Object>} Full product detail in ACP format
   */
  async execute(args) {
    const url = `${BASE_URL}/api/v1/catalog/products/${encodeURIComponent(args.product_id)}`;
    const res = await fetch(url, {
      headers: { 'Content-Type': 'application/json' },
    });
    const json = await res.json();

    if (json.status !== 'success') {
      throw new Error(`get_product failed: ${json.message || JSON.stringify(json)}`);
    }

    return json.data;
  },
};

module.exports = getProductTool;
