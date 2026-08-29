/**
 * @module agent/tools/index
 * @description Unified registry of all 9 LLM function-calling tools for the
 * AI Buyer Agent (ACG v2).
 *
 * Each tool follows the OpenAI / Gemini function-calling schema:
 *   { name, description, parameters, execute(args, options) }
 *
 * The `allTools` array is the canonical list passed to the LLM at inference
 * time. The `toolMap` object enables O(1) dispatch when the LLM returns a
 * function call by name.
 *
 * Tool Catalogue:
 * ┌──────────────────────────────────────┬─────────────────────────────────────────┐
 * │ Tool Name                            │ Gateway Endpoint                        │
 * ├──────────────────────────────────────┼─────────────────────────────────────────┤
 * │ search_catalog                       │ GET  /api/v1/catalog/search             │
 * │ search_web                           │ GET  /api/v1/discovery/search           │
 * │ get_product                          │ GET  /api/v1/catalog/products/:id       │
 * │ compare_products                     │ POST /api/v1/recommendations/compare    │
 * │ find_coupons                         │ GET  /api/v1/coupons                    │
 * │ validate_coupon                      │ POST /api/v1/coupons/validate           │
 * │ create_cart                          │ POST /api/v1/mandates/cart              │
 * │ request_purchase_confirmation        │ POST /api/v1/mandates/cart/confirm      │
 * │ execute_payment                      │ POST /api/v1/payments/execute           │
 * └──────────────────────────────────────┴─────────────────────────────────────────┘
 *
 * @see docs/TRD.md Section 7 — Agent Function-Calling Tooling
 */

const searchCatalogTool              = require('./search-catalog');
const searchWebTool                  = require('./search-web');
const getProductTool                 = require('./get-product');
const compareProductsTool            = require('./compare-products');
const findCouponsTool                = require('./find-coupons');
const validateCouponTool             = require('./validate-coupon');
const createCartTool                 = require('./create-cart');
const requestPurchaseConfirmationTool = require('./request-purchase-confirmation');
const executePaymentTool             = require('./execute-payment');

// ── Canonical ordered list (passed to LLM at inference time) ─────────

const allTools = [
  searchCatalogTool,
  searchWebTool,
  getProductTool,
  compareProductsTool,
  findCouponsTool,
  validateCouponTool,
  createCartTool,
  requestPurchaseConfirmationTool,
  executePaymentTool,
];

// ── Fast O(1) dispatch map ───────────────────────────────────────────

const toolMap = Object.fromEntries(allTools.map((t) => [t.name, t]));

/**
 * Dispatch a function-call result from the LLM to the correct tool.
 *
 * @param {string} toolName - The `name` field returned by the LLM
 * @param {Object} args - The parsed arguments object from the LLM
 * @param {Object} [options] - Optional runtime options passed to execute()
 * @param {string} [options.agentId] - Agent ID for authenticated requests
 * @returns {Promise<any>} Tool execution result
 * @throws {Error} If the tool name is not registered
 */
async function dispatchTool(toolName, args, options = {}) {
  const tool = toolMap[toolName];
  if (!tool) {
    throw new Error(`Unknown tool: "${toolName}". Available tools: [${allTools.map((t) => t.name).join(', ')}]`);
  }
  return tool.execute(args, options);
}

/**
 * Return tool schemas in the format expected by the Gemini/OpenAI function-calling API.
 * Each schema contains { name, description, parameters }.
 *
 * @returns {Object[]} Array of tool schemas
 */
function getToolSchemas() {
  return allTools.map(({ name, description, parameters }) => ({
    name,
    description,
    parameters,
  }));
}

module.exports = {
  allTools,
  toolMap,
  dispatchTool,
  getToolSchemas,
  // Named re-exports for direct imports
  searchCatalogTool,
  searchWebTool,
  getProductTool,
  compareProductsTool,
  findCouponsTool,
  validateCouponTool,
  createCartTool,
  requestPurchaseConfirmationTool,
  executePaymentTool,
};
