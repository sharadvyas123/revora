/**
 * @module agent/tools/request-purchase-confirmation
 * @description LLM function-calling tool for explicit purchase confirmation.
 *
 * Calls POST /api/v1/mandates/cart/confirm on the gateway to record
 * the human delegator's explicit approval or rejection of the purchase.
 *
 * This is the SECURITY GATE (Phase 13) — payments CANNOT execute
 * until this confirmation is recorded. The gateway will return
 * HTTP 403 CONFIRMATION_REQUIRED if payment is attempted without it.
 *
 * Channel indicates HOW the confirmation was received:
 *   - VOICE: user spoke a confirmation phrase
 *   - TEXT:  user typed a message
 *   - API:   programmatic / webhook confirmation
 *
 * @see docs/TRD.md Section 4.3 — Explicit Purchase Confirmation Gate
 * @see gateway/services/mandate.service.js — confirmCartMandate()
 */

const BASE_URL = process.env.GATEWAY_URL || 'http://localhost:3000';

/**
 * Tool schema for request_purchase_confirmation — used by the LLM function-calling layer.
 */
const requestPurchaseConfirmationTool = {
  name: 'request_purchase_confirmation',
  description: 'Record the human user\'s explicit confirmation or rejection of a purchase. MUST be called after cart approval and before executing payment — the payment gateway blocks transactions until this confirmation is on record. Captures the channel (VOICE/TEXT/API) and optional confirmation phrase for the audit trail.',
  parameters: {
    type: 'object',
    properties: {
      cart_mandate_id: {
        type: 'string',
        description: 'The cart mandate ID that requires explicit confirmation before payment',
      },
      user_confirmation: {
        type: 'boolean',
        description: 'true = user confirmed the purchase; false = user rejected / cancelled',
      },
      channel: {
        type: 'string',
        enum: ['VOICE', 'TEXT', 'API'],
        description: 'The channel through which confirmation was received',
      },
      confirmation_phrase: {
        type: 'string',
        description: 'Optional: the exact phrase spoken or typed by the user (e.g. "Yes, buy it", "Proceed with purchase")',
      },
    },
    required: ['cart_mandate_id', 'user_confirmation', 'channel'],
  },

  /**
   * Execute the explicit purchase confirmation recording.
   *
   * @param {Object} args
   * @param {string} args.cart_mandate_id - Cart mandate to confirm
   * @param {boolean} args.user_confirmation - true = confirmed, false = rejected
   * @param {'VOICE'|'TEXT'|'API'} args.channel - Confirmation channel
   * @param {string} [args.confirmation_phrase] - Exact user phrase
   * @param {Object} [options]
   * @param {string} [options.agentId] - Agent ID for headers
   * @returns {Promise<Object>} { cart_mandate_id, confirmation_status, ready_for_payment, confirmed_at }
   */
  async execute(args, options = {}) {
    const headers = { 'Content-Type': 'application/json' };
    if (options.agentId) headers['x-agent-id'] = options.agentId;

    const url = `${BASE_URL}/api/v1/mandates/cart/confirm`;
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        cart_mandate_id: args.cart_mandate_id,
        user_confirmation: args.user_confirmation,
        channel: args.channel,
        confirmation_phrase: args.confirmation_phrase || undefined,
      }),
    });
    const json = await res.json();

    if (json.status !== 'success') {
      throw new Error(`request_purchase_confirmation failed: ${json.message || JSON.stringify(json)}`);
    }

    return json.data;
  },
};

module.exports = requestPurchaseConfirmationTool;
