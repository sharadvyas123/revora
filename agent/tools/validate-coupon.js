/**
 * @module agent/tools/validate-coupon
 * @description LLM function-calling tool for coupon validation and discount computation.
 *
 * Calls POST /api/v1/coupons/validate on the gateway. This is a read-only
 * check — it validates the coupon code and computes the discount amount
 * WITHOUT incrementing the usage counter (unlike /apply which is used
 * during cart mandate creation when the coupon is actually consumed).
 *
 * Use this BEFORE creating the cart to show the user the exact savings
 * and final price before they commit to the purchase.
 *
 * @see docs/TRD.md Section 3.5 — Coupon & Voucher System
 */

const BASE_URL = process.env.GATEWAY_URL || 'http://localhost:3000';

/**
 * Tool schema for validate_coupon — used by the LLM function-calling layer.
 */
const validateCouponTool = {
  name: 'validate_coupon',
  description: 'Validate a coupon code and compute the exact discount without consuming it. Returns the discount amount, final price, and validation status. Use this to show the user confirmed savings before they approve the cart.',
  parameters: {
    type: 'object',
    properties: {
      coupon_code: {
        type: 'string',
        description: 'The coupon code to validate (e.g. "RUN500", "SAVE10")',
      },
      merchant_id: {
        type: 'string',
        description: 'The merchant ID the coupon belongs to (e.g. "merch_sportshub")',
      },
      amount: {
        type: 'integer',
        description: 'Cart total in paise before the discount (e.g. 279900 for ₹2,799)',
      },
      category: {
        type: 'string',
        description: 'Product category to validate category-restricted coupons (e.g. "footwear")',
      },
    },
    required: ['coupon_code', 'merchant_id', 'amount'],
  },

  /**
   * Execute the coupon validation (read-only, does NOT consume the coupon).
   *
   * @param {Object} args
   * @param {string} args.coupon_code - Code to validate
   * @param {string} args.merchant_id - Merchant the coupon belongs to
   * @param {number} args.amount - Cart amount in paise
   * @param {string} [args.category] - Product category
   * @param {Object} [options]
   * @param {string} [options.agentId] - Agent ID for headers
   * @returns {Promise<Object>} { valid, discount_amount, final_amount, coupon, savings_display }
   */
  async execute(args, options = {}) {
    const headers = { 'Content-Type': 'application/json' };
    if (options.agentId) headers['x-agent-id'] = options.agentId;

    const url = `${BASE_URL}/api/v1/coupons/validate`;
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        code: args.coupon_code,
        merchant_id: args.merchant_id,
        amount: args.amount,
        category: args.category || undefined,
      }),
    });
    const json = await res.json();

    if (json.status !== 'success') {
      if (res.status === 400 || res.status === 422 || res.status === 404) {
        return {
          valid: false,
          error_code: json.error,
          message: json.message,
        };
      }
      throw new Error(`validate_coupon failed: ${json.message || JSON.stringify(json)}`);
    }

    return json.data;
  },
};

module.exports = validateCouponTool;
