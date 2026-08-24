/**
 * @module agent/agent
 * @description Main AI Buyer Agent orchestrator for the Agentic Commerce Gateway.
 *
 * Dual-Mode LLM Support:
 *   - Google Gemini (gemini-1.5-flash) when GEMINI_API_KEY is set in .env
 *   - Local deterministic NLU engine as fallback when no key is configured
 *
 * Full autonomous purchase flow (8 steps):
 *   Step 1: Parse Intent     → Gemini LLM or local NLU extracts constraints
 *   Step 2: Create Mandate   → POST /mandates/intent (human spending authorization)
 *   Step 3: Search Catalog   → discover products matching intent
 *   Step 4: Decide           → Gemini LLM or local scoring selects optimal product
 *   Step 5: Create Cart      → POST /mandates/cart (submit selection + reasoning)
 *   Step 6: Human Approval   → POST /mandates/cart/:id/approve (simulated gate)
 *   Step 7: Execute Payment  → POST /payments/execute (money moves)
 *   Step 8: Verify           → GET /payments/:id (confirm CAPTURED)
 *
 * @see docs/PRD.md Section 5 — Bounded, Explainable, Gated, Auditable
 * @see agent/gemini-llm.js — Google Gemini integration layer
 */

require('dotenv').config();
const { parseIntent } = require('./intent-parser');
const { searchCatalog } = require('./catalog-searcher');
const { decide } = require('./decision-engine');
const { isAvailable: isGeminiAvailable } = require('./gemini-llm');
const createCartTool = require('./tools/create-cart');
const executePaymentTool = require('./tools/execute-payment');

const BASE_URL = process.env.GATEWAY_URL || 'http://localhost:3000';

// ── ANSI Color Helpers ──────────────────────────────────────────────

const c = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  red: '\x1b[31m',
  white: '\x1b[97m',
  bgBlue: '\x1b[44m',
  bgGreen: '\x1b[42m',
  bgRed: '\x1b[41m',
  bgYellow: '\x1b[43m',
};

function header(text) {
  console.log(`\n${c.bgBlue}${c.white}${c.bold}  ${text}  ${c.reset}\n`);
}

function llmBadge() {
  if (isGeminiAvailable()) {
    return `${c.magenta}${c.bold}[✦ Gemini LLM Active]${c.reset}`;
  }
  return `${c.dim}[Local NLU Engine]${c.reset}`;
}

function step(num, text) {
  console.log(`  ${c.cyan}${c.bold}STEP ${num}${c.reset}  ${text}`);
}

function success(text) {
  console.log(`  ${c.green}✓${c.reset} ${text}`);
}

function info(text) {
  console.log(`  ${c.dim}${text}${c.reset}`);
}

function warn(text) {
  console.log(`  ${c.yellow}⚠${c.reset} ${text}`);
}

function fail(text) {
  console.log(`  ${c.red}✗${c.reset} ${text}`);
}

// ── BuyerAgent Class ────────────────────────────────────────────────

class BuyerAgent {
  /**
   * @param {Object} config
   * @param {string} config.agentId - Agent identifier (e.g. "agent_shopper_01")
   * @param {string} config.delegatorId - Human delegator ID (e.g. "user_jane_doe")
   * @param {string} [config.baseUrl] - Gateway base URL
   */
  constructor(config = {}) {
    this.agentId = config.agentId || 'agent_shopper_01';
    this.delegatorId = config.delegatorId || 'user_jane_doe';
    this.baseUrl = config.baseUrl || BASE_URL;
  }

  /**
   * Run the full autonomous purchase flow from a natural language prompt.
   * 
   * @param {string} prompt - Human's purchase instruction
   *   e.g. "buy running shoes under 3000 rupees"
   * @param {Object} [options]
   * @param {Object} [options.intentOverrides] - Override parsed intent constraints
   * @param {boolean} [options.autoApprove=true] - Simulate human approval (default: true)
   * @returns {Promise<Object>} Full flow result with timing and audit data
   */
  async run(prompt, options = {}) {
    const startTime = Date.now();
    const autoApprove = options.autoApprove !== false;
    const flowResult = {
      prompt,
      steps: {},
      success: false,
      error: null,
    };

    try {
      header('🤖 AI Buyer Agent — Autonomous Purchase Flow');
      console.log(`  ${c.bold}Prompt:${c.reset} "${prompt}"`);
      console.log(`  ${c.bold}Agent:${c.reset}  ${this.agentId}`);
      console.log(`  ${c.bold}Human:${c.reset}  ${this.delegatorId}`);
      console.log(`  ${c.bold}LLM:${c.reset}    ${llmBadge()}`);

      // ── Step 1: Parse Intent ──────────────────────────────────────
      step(1, `Parse Intent (${isGeminiAvailable() ? 'Gemini LLM' : 'Local NLU'})`);
      const intent = await parseIntent(prompt);

      // Apply any overrides
      if (options.intentOverrides) {
        Object.assign(intent, options.intentOverrides);
      }

      success(`Keywords: [${intent.keywords.join(', ')}]`);
      success(`Category: ${intent.category || 'auto-detect'}`);
      success(`Budget: ${intent.max_price ? `₹${(intent.max_price / 100).toLocaleString('en-IN')}` : 'unlimited'}`);
      success(`Quantity: ${intent.quantity}`);
      if (intent.gemini_reasoning) info(`  Gemini: "${intent.gemini_reasoning}"`);
      flowResult.steps.parse = { intent, duration_ms: Date.now() - startTime };

      // ── Step 2: Create Intent Mandate ─────────────────────────────
      step(2, 'Create Intent Mandate (human spending authorization)');
      const intentMandate = await this._createIntentMandate(intent);
      success(`Mandate ID: ${intentMandate.mandate_id}`);
      success(`Status: ${intentMandate.status}`);
      const constraintsObj = intentMandate.constraints || {};
      success(`Constraints: max ₹${((constraintsObj.max_amount || 0) / 100).toLocaleString('en-IN')}`);
      flowResult.steps.intent_mandate = {
        mandate_id: intentMandate.mandate_id,
        duration_ms: Date.now() - startTime,
      };

      // ── Step 3: Search Catalog ────────────────────────────────────
      step(3, 'Search Catalog (product discovery)');
      const searchContext = await searchCatalog(intent, {
        auditTrailId: intentMandate.mandate_id,
        agentId: this.agentId,
      });

      success(`Strategy: ${searchContext.search_strategy}`);
      success(`Results: ${searchContext.total_matches} products found`);

      if (searchContext.total_matches === 0) {
        warn('No products found matching the criteria.');
        flowResult.steps.search = { total_matches: 0, strategy: searchContext.search_strategy };
        flowResult.error = 'NO_PRODUCTS_FOUND';
        return this._finalizeResult(flowResult, startTime);
      }

      for (const r of searchContext.results) {
        info(`  → ${r.product.name} | ${r.product.price.display} | ${r.product.rating}★ | relevance: ${(r.relevance_score * 100).toFixed(0)}%`);
      }
      flowResult.steps.search = {
        total_matches: searchContext.total_matches,
        strategy: searchContext.search_strategy,
        duration_ms: Date.now() - startTime,
      };

      // ── Step 4: Decision Engine ───────────────────────────────────
      step(4, `Decision Engine (${isGeminiAvailable() ? 'Gemini LLM Reasoning' : 'Weighted Scoring'})`);
      const decision = await decide(searchContext.results, intent);

      if (!decision.selected) {
        warn('Decision engine could not select a product.');
        warn(decision.reasoning);
        flowResult.steps.decision = { selected: null, reasoning: decision.reasoning };
        flowResult.error = 'NO_VIABLE_CANDIDATE';
        return this._finalizeResult(flowResult, startTime);
      }

      success(`Selected: ${decision.selected.name} (${decision.selected.price.display})`);
      if (decision.llm_mode === 'gemini') {
        success(`${c.magenta}✦ Gemini Reasoning:${c.reset} ${decision.selected.reason}`);
      } else {
        success(`Score: ${decision.selected.composite_score}`);
        success(`Reason: ${decision.selected.reason}`);
      }
      if (decision.alternatives.length > 0) {
        info(`  Alternatives considered: ${decision.alternatives.length}`);
        for (const alt of decision.alternatives.slice(0, 3)) {
          info(`    → ${alt.name || alt.product_id} | ${alt.price?.display || ''} | ${alt.reason}`);
        }
      }
      flowResult.steps.decision = {
        selected: decision.selected,
        alternatives_count: decision.alternatives.length,
        duration_ms: Date.now() - startTime,
      };

      // ── Step 5: Create Cart Mandate ───────────────────────────────
      step(5, 'Create Cart (submit selection for human approval)');
      const cartMandate = await createCartTool.execute({
        intent_mandate_id: intentMandate.mandate_id,
        agent_id: this.agentId,
        items: [{
          product_id: decision.selected.product_id,
          variant_id: decision.selected.variant_id,
          quantity: intent.quantity,
        }],
        reasoning: {
          query: intent.raw_prompt,
          reason: decision.selected.reason,
          alternatives: decision.alternatives.slice(0, 3).map((alt) => ({
            product_id: alt.product_id,
            reason: alt.reason,
          })),
        },
      });

      success(`Cart Mandate: ${cartMandate.mandate_id}`);
      success(`Status: ${cartMandate.status}`);
      success(`Total: ${cartMandate.cart?.total_display || 'N/A'}`);
      flowResult.steps.cart = {
        mandate_id: cartMandate.mandate_id,
        total: cartMandate.cart?.total_amount,
        duration_ms: Date.now() - startTime,
      };

      // ── Step 6: Human Approval Gate ───────────────────────────────
      step(6, 'Human Approval Gate');
      if (!autoApprove) {
        warn('Auto-approve disabled. Cart is PENDING_APPROVAL.');
        flowResult.steps.approval = { status: 'PENDING_APPROVAL', auto_approve: false };
        flowResult.error = 'AWAITING_HUMAN_APPROVAL';
        return this._finalizeResult(flowResult, startTime);
      }

      info('  [Simulating human approval...]');
      const paymentMandate = await this._approveCart(cartMandate.mandate_id);
      success(`Payment Mandate: ${paymentMandate.mandate_id}`);
      success(`Status: ${paymentMandate.status}`);
      flowResult.steps.approval = {
        mandate_id: paymentMandate.mandate_id,
        auto_approve: true,
        duration_ms: Date.now() - startTime,
      };

      // ── Step 7: Execute Payment ───────────────────────────────────
      step(7, 'Execute Payment (money moves)');
      const transaction = await executePaymentTool.execute({
        payment_mandate_id: paymentMandate.mandate_id,
        agent_id: this.agentId,
      });

      success(`Transaction: ${transaction.transaction_id}`);
      success(`Status: ${c.bgGreen}${c.white} ${transaction.status} ${c.reset}`);
      success(`Razorpay Order: ${transaction.razorpay?.order_id}`);
      success(`Razorpay Payment: ${transaction.razorpay?.payment_id}`);
      success(`Total: ${transaction.order?.total_display}`);
      flowResult.steps.payment = {
        transaction_id: transaction.transaction_id,
        status: transaction.status,
        razorpay_order_id: transaction.razorpay?.order_id,
        total: transaction.order?.total_amount,
        duration_ms: Date.now() - startTime,
      };

      // ── Step 8: Verify ────────────────────────────────────────────
      step(8, 'Verify Transaction');
      const verification = await this._verifyTransaction(transaction.transaction_id);
      success(`Verified Status: ${verification.status}`);
      success(`Completed At: ${verification.completed_at}`);
      success(`Audit Trail: ${verification.audit_trail_id}`);
      flowResult.steps.verification = {
        status: verification.status,
        completed_at: verification.completed_at,
        audit_trail_id: verification.audit_trail_id,
        duration_ms: Date.now() - startTime,
      };

      flowResult.success = true;

    } catch (err) {
      fail(`Error: ${err.message}`);
      flowResult.error = err.message;
    }

    return this._finalizeResult(flowResult, startTime);
  }

  // ══════════════════════════════════════════════════════════════════
  //  PRIVATE HELPERS — Gateway API calls
  // ══════════════════════════════════════════════════════════════════

  /**
   * Create an Intent Mandate on the gateway.
   * @param {Object} intent - Parsed intent
   * @returns {Promise<Object>} Intent mandate data
   * @private
   */
  async _createIntentMandate(intent) {
    const res = await fetch(`${this.baseUrl}/api/v1/mandates/intent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        delegator_id: this.delegatorId,
        agent_id: this.agentId,
        constraints: {
          max_amount: intent.max_price || 10000000, // Default 1 lakh if no budget
          currency: intent.currency || 'INR',
          allowed_categories: intent.category ? [intent.category] : [],
          single_use: true,
        },
        ttl: 3600,
      }),
    });

    const json = await res.json();
    if (json.status !== 'success') {
      throw new Error(`Create intent mandate failed: ${json.message || JSON.stringify(json)}`);
    }

    return json.data;
  }

  /**
   * Approve a cart mandate (simulated human approval).
   * @param {string} cartMandateId - Cart mandate ID to approve
   * @returns {Promise<Object>} Payment mandate data
   * @private
   */
  async _approveCart(cartMandateId) {
    const res = await fetch(`${this.baseUrl}/api/v1/mandates/cart/${cartMandateId}/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        approved_by: this.delegatorId,
      }),
    });

    const json = await res.json();
    if (json.status !== 'success') {
      throw new Error(`Cart approval failed: ${json.message || JSON.stringify(json)}`);
    }

    return json.data;
  }

  /**
   * Verify a transaction status.
   * @param {string} transactionId - Transaction ID to verify
   * @returns {Promise<Object>} Transaction data
   * @private
   */
  async _verifyTransaction(transactionId) {
    const res = await fetch(`${this.baseUrl}/api/v1/payments/${transactionId}`);
    const json = await res.json();

    if (json.status !== 'success') {
      throw new Error(`Transaction verification failed: ${json.message || JSON.stringify(json)}`);
    }

    return json.data;
  }

  /**
   * Finalize the flow result with timing data.
   * @private
   */
  _finalizeResult(result, startTime) {
    result.total_duration_ms = Date.now() - startTime;

    console.log('');
    if (result.success) {
      console.log(`${c.bgGreen}${c.white}${c.bold}  ✅ PURCHASE COMPLETE  ${c.reset}`);
    } else {
      console.log(`${c.bgRed}${c.white}${c.bold}  ❌ FLOW STOPPED: ${result.error}  ${c.reset}`);
    }
    console.log(`  ${c.dim}Total time: ${result.total_duration_ms}ms${c.reset}`);
    console.log('');

    return result;
  }
}

module.exports = BuyerAgent;
