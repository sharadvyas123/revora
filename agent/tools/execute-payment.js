/**
 * @module agent/tools/execute-payment
 * @description LLM function-calling tool definition for payment execution.
 * 
 * Calls POST /api/v1/payments/execute on the gateway to execute the final
 * payment using an approved Payment Mandate token.
 * 
 * @see docs/TRD.md Section 5 — Payment Gateway Integration
 */

const BASE_URL = process.env.GATEWAY_URL || 'http://localhost:3000';

/**
 * Tool schema for execute_payment — used by the LLM function-calling layer.
 */
const executePaymentTool = {
  name: 'execute_payment',
  description: 'Execute payment using an approved Payment Mandate token. This is the terminal action — money moves. Requires prior human approval of the cart.',
  parameters: {
    type: 'object',
    properties: {
      payment_mandate_id: {
        type: 'string',
        description: 'The payment mandate ID (issued after cart approval)',
      },
      agent_id: {
        type: 'string',
        description: 'The agent ID executing the payment',
      },
      payment_method: {
        type: 'string',
        enum: ['upi', 'card', 'netbanking', 'wallet'],
        description: 'Payment method (default: "upi")',
      },
    },
    required: ['payment_mandate_id', 'agent_id'],
  },

  /**
   * Execute the payment against the gateway API.
   * 
   * @param {Object} args
   * @param {string} args.payment_mandate_id - Payment mandate ID
   * @param {string} args.agent_id - Agent ID
   * @param {string} [args.payment_method='upi'] - Payment method
   * @returns {Promise<Object>} Transaction result with Razorpay IDs
   */
  async execute(args) {
    const url = `${BASE_URL}/api/v1/payments/execute`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        payment_mandate_id: args.payment_mandate_id,
        agent_id: args.agent_id,
        payment_method: args.payment_method || 'upi',
      }),
    });
    const json = await res.json();

    if (json.status !== 'success') {
      throw new Error(`execute_payment failed: ${json.message || JSON.stringify(json)}`);
    }

    return json.data;
  },
};

module.exports = executePaymentTool;
