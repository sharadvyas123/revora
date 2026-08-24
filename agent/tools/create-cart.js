/**
 * @module agent/tools/create-cart
 * @description LLM function-calling tool definition for cart mandate creation.
 * 
 * Calls POST /api/v1/mandates/cart on the gateway to submit the agent's
 * selected items and reasoning for human approval.
 * 
 * @see docs/TRD.md Section 4 — Mandate API
 */

const BASE_URL = process.env.GATEWAY_URL || 'http://localhost:3000';

/**
 * Tool schema for create_cart — used by the LLM function-calling layer.
 */
const createCartTool = {
  name: 'create_cart',
  description: 'Submit a cart of selected items for human approval. Includes the agent\'s reasoning for the selection. Returns a cart mandate in PENDING_APPROVAL status.',
  parameters: {
    type: 'object',
    properties: {
      intent_mandate_id: {
        type: 'string',
        description: 'The parent intent mandate ID that authorizes this purchase',
      },
      agent_id: {
        type: 'string',
        description: 'The agent ID making the purchase',
      },
      items: {
        type: 'array',
        description: 'Array of items to purchase',
        items: {
          type: 'object',
          properties: {
            product_id: { type: 'string', description: 'Product ID' },
            variant_id: { type: 'string', description: 'Optional variant ID' },
            quantity: { type: 'integer', description: 'Quantity (default: 1)' },
          },
          required: ['product_id'],
        },
      },
      reasoning: {
        type: 'object',
        description: 'The agent\'s reasoning for this selection',
        properties: {
          query: { type: 'string', description: 'Original search query' },
          reason: { type: 'string', description: 'Why this product was selected' },
          alternatives: {
            type: 'array',
            description: 'Other products considered and why they were not selected',
            items: {
              type: 'object',
              properties: {
                product_id: { type: 'string' },
                reason: { type: 'string' },
              },
            },
          },
        },
      },
    },
    required: ['intent_mandate_id', 'agent_id', 'items'],
  },

  /**
   * Execute the cart creation against the gateway API.
   * 
   * @param {Object} args
   * @param {string} args.intent_mandate_id - Parent intent mandate ID
   * @param {string} args.agent_id - Agent ID
   * @param {Array} args.items - Items to purchase
   * @param {Object} [args.reasoning] - Agent's reasoning
   * @returns {Promise<Object>} Cart mandate (PENDING_APPROVAL)
   */
  async execute(args) {
    const url = `${BASE_URL}/api/v1/mandates/cart`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        intent_mandate_id: args.intent_mandate_id,
        agent_id: args.agent_id,
        items: args.items,
        reasoning: args.reasoning || {},
      }),
    });
    const json = await res.json();

    if (json.status !== 'success') {
      throw new Error(`create_cart failed: ${json.message || JSON.stringify(json)}`);
    }

    return json.data;
  },
};

module.exports = createCartTool;
