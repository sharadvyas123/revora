/**
 * @module agent/tools/find-coupons
 * @description LLM function-calling tool for coupon discovery.
 *
 * Calls GET /api/v1/coupons on the gateway to list all active,
 * non-expired coupons for a given merchant, with optional category
 * and minimum order amount filters.
 *
 * Use this BEFORE creating the cart to discover any applicable discounts.
 * Pass relevant coupons to validate_coupon to compute exact savings.
 *
 * @see docs/TRD.md Section 3.5 — Coupon & Voucher System
 */

const BASE_URL = process.env.GATEWAY_URL || 'http://localhost:3000';

/**
 * Tool schema for find_coupons — used by the LLM function-calling layer.
 */
const findCouponsTool = {
  name: 'find_coupons',
  description: 'Discover active coupons and discount codes available for a merchant. Returns all valid coupons with their discount type, value, minimum order amount, and applicable categories. Call this before checkout to surface potential savings for the user.',
  parameters: {
    type: 'object',
    properties: {
      merchant_id: {
        type: 'string',
        description: 'The merchant ID to look up coupons for (e.g. "merch_sportshub")',
      },
      category: {
        type: 'string',
        description: 'Optional category to filter coupons by (e.g. "footwear", "apparel")',
      },
      amount: {
        type: 'integer',
        description: 'Optional cart amount in paise to filter coupons by minimum order requirement',
      },
    },
    required: ['merchant_id'],
  },

  /**
   * Execute the coupon listing.
   *
   * @param {Object} args
   * @param {string} args.merchant_id - Merchant to list coupons for
   * @param {string} [args.category] - Category filter
   * @param {number} [args.amount] - Order amount filter in paise
   * @param {Object} [options]
   * @param {string} [options.agentId] - Agent ID for headers
   * @returns {Promise<Object>} { merchant_id, total, coupons[] }
   */
  async execute(args, options = {}) {
    const params = new URLSearchParams();
    params.set('merchant_id', args.merchant_id);
    if (args.category) params.set('category', args.category);
    if (args.amount) params.set('amount', args.amount.toString());

    const headers = { 'Content-Type': 'application/json' };
    if (options.agentId) headers['x-agent-id'] = options.agentId;

    const url = `${BASE_URL}/api/v1/coupons?${params.toString()}`;
    const res = await fetch(url, { headers });
    const json = await res.json();

    if (json.status !== 'success') {
      throw new Error(`find_coupons failed: ${json.message || JSON.stringify(json)}`);
    }

    return json.data;
  },
};

module.exports = findCouponsTool;
