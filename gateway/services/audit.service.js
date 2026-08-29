/**
 * @module gateway/services/audit.service
 * @description Append-only audit trail engine for the Agentic Commerce Gateway.
 * 
 * Every action in the autonomous commerce lifecycle is logged as an immutable
 * audit entry. The audit trail provides complete traceability for:
 * - Regulatory compliance (who authorized what, when)
 * - Dispute resolution (what the AI agent decided and why)
 * - Debugging (full step-by-step replay of any transaction)
 * 
 * Step Taxonomy (v1 + v2):
 *   REQUEST              — User prompt parsed, intent defined
 *   DISCOVERY            — Catalog search queries & matching candidates (v1)
 *   PRODUCT_DISCOVERY    — Multi-source discovery (local + external web) (v2)
 *   PRODUCT_RECOMMENDATION — AI-scored ranking of discovered products (v2)
 *   PRODUCT_COMPARISON   — Side-by-side comparison matrix generated (v2)
 *   COUPON_PROVIDED      — Available coupons listed for the merchant (v2)
 *   COUPON_VALIDATED     — Coupon validated, discount amount computed (v2)
 *   DISCOUNT_APPLIED     — Coupon applied and discounted cart created (v2)
 *   DECISION             — AI reasoning for product selection vs alternatives
 *   MANDATE_CHECK        — Constraint evaluation (spend cap, category)
 *   APPROVAL             — Human approval/rejection with delegator context
 *   PURCHASE_CONFIRMATION — Explicit user confirmation recorded (v2)
 *   PAYMENT              — Razorpay order creation, token consumption, capture
 *   OUTCOME              — Final state (CAPTURED, REJECTED, FAILED)
 *   ERROR                — Unexpected errors during any step
 * 
 * Immutability is enforced at the database level by SQL triggers that
 * block any UPDATE or DELETE on the audit_entries table.
 * 
 * @see docs/TRD.md Section 6 — Audit Trail Specification
 * @see docs/PRD.md Section 5 — F5: Audit & Compliance
 * @see db/migrations/001_initial.sql — audit_entries table + triggers
 */

const { v4: uuidv4 } = require('uuid');
const logger = require('../../lib/logger');

class AuditService {
  /**
   * @param {import('better-sqlite3').Database} db - The better-sqlite3 database instance
   */
  constructor(db) {
    this.db = db;
  }

  // ════════════════════════════════════════════════════════════════════
  //  WRITE — Append-only audit event logging
  // ════════════════════════════════════════════════════════════════════

  /**
   * Log an immutable audit event.
   * 
   * @param {Object} params
   * @param {string} params.audit_trail_id - Groups all entries for one transaction
   * @param {string} params.step - Step type: REQUEST|DISCOVERY|DECISION|MANDATE_CHECK|APPROVAL|PAYMENT|OUTCOME|ERROR
   * @param {Object} params.data - Step-specific payload (fully serialized)
   * @returns {Object} The created audit entry
   */
  logEvent({ audit_trail_id, step, data }) {
    const entryId = `ae_${step.toLowerCase()}_${uuidv4().split('-')[0]}`;
    const timestamp = new Date().toISOString();

    this.db.prepare(`
      INSERT INTO audit_entries (entry_id, audit_trail_id, step, timestamp, data)
      VALUES (?, ?, ?, ?, ?)
    `).run(entryId, audit_trail_id, step, timestamp, JSON.stringify(data));

    logger.debug('Audit event logged', {
      entry_id: entryId,
      audit_trail_id,
      step,
    });

    return { entry_id: entryId, audit_trail_id, step, timestamp, data };
  }

  /**
   * Log a complete transaction flow as a batch of audit events.
   * Used to retroactively audit transactions that were completed before
   * the audit service was installed.
   * 
   * @param {string} auditTrailId - Trail ID
   * @param {Object[]} events - Array of {step, data} objects
   * @returns {Object[]} Created audit entries
   */
  logBatch(auditTrailId, events) {
    const entries = [];
    const insertMany = this.db.transaction(() => {
      for (const event of events) {
        const entry = this.logEvent({
          audit_trail_id: auditTrailId,
          step: event.step,
          data: event.data,
        });
        entries.push(entry);
      }
    });
    insertMany();
    return entries;
  }

  // ════════════════════════════════════════════════════════════════════
  //  Convenience loggers for each step type
  // ════════════════════════════════════════════════════════════════════

  /**
   * Log a REQUEST step — user prompt parsed and intent defined.
   */
  logRequest(auditTrailId, { agent_id, delegator_id, query, constraints }) {
    return this.logEvent({
      audit_trail_id: auditTrailId,
      step: 'REQUEST',
      data: { agent_id, delegator_id, query, constraints, action: 'intent_created' },
    });
  }

  /**
   * Log a DISCOVERY step — catalog search performed.
   */
  logDiscovery(auditTrailId, { agent_id, query, keywords, results_count, top_results }) {
    return this.logEvent({
      audit_trail_id: auditTrailId,
      step: 'DISCOVERY',
      data: { agent_id, query, keywords, results_count, top_results, action: 'catalog_searched' },
    });
  }

  /**
   * Log a DECISION step — AI agent's product selection reasoning.
   */
  logDecision(auditTrailId, { agent_id, selected_product, reason, alternatives, score }) {
    return this.logEvent({
      audit_trail_id: auditTrailId,
      step: 'DECISION',
      data: { agent_id, selected_product, reason, alternatives, score, action: 'product_selected' },
    });
  }

  /**
   * Log a MANDATE_CHECK step — constraint evaluation.
   */
  logMandateCheck(auditTrailId, { mandate_id, mandate_type, constraints, check_result, violation }) {
    return this.logEvent({
      audit_trail_id: auditTrailId,
      step: 'MANDATE_CHECK',
      data: {
        mandate_id,
        mandate_type,
        constraints,
        check_result, // 'PASSED' or 'FAILED'
        ...(violation && { violation }),
        action: 'mandate_validated',
      },
    });
  }

  /**
   * Log an APPROVAL step — human approval or rejection.
   */
  logApproval(auditTrailId, { cart_mandate_id, delegator_id, decision, reason, payment_mandate_id }) {
    return this.logEvent({
      audit_trail_id: auditTrailId,
      step: 'APPROVAL',
      data: {
        cart_mandate_id,
        delegator_id,
        decision, // 'APPROVED' or 'REJECTED'
        ...(reason && { reason }),
        ...(payment_mandate_id && { payment_mandate_id }),
        action: decision === 'APPROVED' ? 'cart_approved' : 'cart_rejected',
      },
    });
  }

  /**
   * Log a PAYMENT step — Razorpay order/capture event.
   */
  logPayment(auditTrailId, { transaction_id, razorpay_order_id, razorpay_payment_id, amount, currency, status }) {
    return this.logEvent({
      audit_trail_id: auditTrailId,
      step: 'PAYMENT',
      data: {
        transaction_id,
        razorpay_order_id,
        razorpay_payment_id,
        amount,
        currency,
        status,
        action: 'payment_processed',
      },
    });
  }

  /**
   * Log an OUTCOME step — final transaction result.
   */
  logOutcome(auditTrailId, { transaction_id, status, total_amount, items_count, failure_reason }) {
    return this.logEvent({
      audit_trail_id: auditTrailId,
      step: 'OUTCOME',
      data: {
        transaction_id,
        status,
        total_amount,
        items_count,
        ...(failure_reason && { failure_reason }),
        action: status === 'CAPTURED' ? 'purchase_completed' : 'purchase_failed',
      },
    });
  }

  /**
   * Log an ERROR step — unexpected error during processing.
   */
  logError(auditTrailId, { step_context, error_code, error_message, stack }) {
    return this.logEvent({
      audit_trail_id: auditTrailId,
      step: 'ERROR',
      data: {
        step_context,
        error_code,
        error_message,
        ...(stack && { stack: stack.substring(0, 500) }),
        action: 'error_occurred',
      },
    });
  }

  // ── v2 Convenience Loggers ─────────────────────────────────────────

  /**
   * Log a PRODUCT_DISCOVERY step — multi-source product discovery (v2).
   * Fired after calling GET /api/v1/discovery/search.
   */
  logProductDiscovery(auditTrailId, { agent_id, query, sources_queried, total_found, top_results }) {
    return this.logEvent({
      audit_trail_id: auditTrailId,
      step: 'PRODUCT_DISCOVERY',
      data: {
        agent_id,
        query,
        sources_queried,
        total_found,
        top_results,
        action: 'multi_source_discovery_complete',
      },
    });
  }

  /**
   * Log a PRODUCT_RECOMMENDATION step — AI-scored product ranking (v2).
   * Fired after calling POST /api/v1/recommendations/decide.
   */
  logProductRecommendation(auditTrailId, { agent_id, query, recommended_product_id, recommendation_reason, candidates_evaluated }) {
    return this.logEvent({
      audit_trail_id: auditTrailId,
      step: 'PRODUCT_RECOMMENDATION',
      data: {
        agent_id,
        query,
        recommended_product_id,
        recommendation_reason,
        candidates_evaluated,
        action: 'recommendation_generated',
      },
    });
  }

  /**
   * Log a PRODUCT_COMPARISON step — side-by-side comparison matrix (v2).
   * Fired after calling POST /api/v1/recommendations/compare.
   */
  logProductComparison(auditTrailId, { agent_id, comparison_id, product_ids, winner_product_id }) {
    return this.logEvent({
      audit_trail_id: auditTrailId,
      step: 'PRODUCT_COMPARISON',
      data: {
        agent_id,
        comparison_id,
        product_ids,
        winner_product_id,
        action: 'comparison_matrix_generated',
      },
    });
  }

  /**
   * Log a COUPON_PROVIDED step — available coupons listed for the merchant (v2).
   * Fired after calling GET /api/v1/coupons.
   */
  logCouponProvided(auditTrailId, { agent_id, merchant_id, coupons_found, coupon_codes }) {
    return this.logEvent({
      audit_trail_id: auditTrailId,
      step: 'COUPON_PROVIDED',
      data: {
        agent_id,
        merchant_id,
        coupons_found,
        coupon_codes,
        action: 'coupons_listed',
      },
    });
  }

  /**
   * Log a COUPON_VALIDATED step — coupon code validated, discount computed (v2).
   * Fired after calling POST /api/v1/coupons/validate.
   */
  logCouponValidated(auditTrailId, { agent_id, coupon_code, merchant_id, original_amount, discount_amount, final_amount, valid }) {
    return this.logEvent({
      audit_trail_id: auditTrailId,
      step: 'COUPON_VALIDATED',
      data: {
        agent_id,
        coupon_code,
        merchant_id,
        original_amount,
        discount_amount,
        final_amount,
        valid,
        action: valid ? 'coupon_valid' : 'coupon_invalid',
      },
    });
  }

  /**
   * Log a DISCOUNT_APPLIED step — coupon consumed and discounted cart created (v2).
   * Fired after cart mandate is created with a coupon applied.
   */
  logDiscountApplied(auditTrailId, { agent_id, cart_mandate_id, coupon_code, original_amount, discount_amount, final_amount }) {
    return this.logEvent({
      audit_trail_id: auditTrailId,
      step: 'DISCOUNT_APPLIED',
      data: {
        agent_id,
        cart_mandate_id,
        coupon_code,
        original_amount,
        discount_amount,
        final_amount,
        action: 'discount_applied_to_cart',
      },
    });
  }

  /**
   * Log a PURCHASE_CONFIRMATION step — explicit user confirmation recorded (v2).
   * Fired after calling POST /api/v1/mandates/cart/confirm.
   * This is the Phase 13 security gate — payment cannot proceed without it.
   */
  logPurchaseConfirmation(auditTrailId, { agent_id, cart_mandate_id, user_confirmation, channel, confirmation_phrase }) {
    return this.logEvent({
      audit_trail_id: auditTrailId,
      step: 'PURCHASE_CONFIRMATION',
      data: {
        agent_id,
        cart_mandate_id,
        user_confirmation,
        channel,
        ...(confirmation_phrase && { confirmation_phrase }),
        action: user_confirmation ? 'purchase_confirmed' : 'purchase_rejected',
      },
    });
  }

  // ════════════════════════════════════════════════════════════════════
  //  READ — Query and inspection methods
  // ════════════════════════════════════════════════════════════════════

  /**
   * Get all audit entries for a specific audit trail (grouped by transaction).
   * Returns entries in chronological order.
   * 
   * @param {string} auditTrailId
   * @returns {Object} Trail with entries and summary
   */
  getByAuditTrailId(auditTrailId) {
    const entries = this.db.prepare(`
      SELECT * FROM audit_entries
      WHERE audit_trail_id = ?
      ORDER BY timestamp ASC
    `).all(auditTrailId);

    return this._formatTrail(auditTrailId, entries);
  }

  /**
   * Get the audit trail for a specific transaction.
   * Looks up the transaction's audit_trail_id and returns the full trail.
   * 
   * @param {string} transactionId
   * @returns {Object} Trail with entries and summary
   */
  getByTransactionId(transactionId) {
    const txn = this.db.prepare(
      'SELECT audit_trail_id FROM transactions WHERE transaction_id = ?'
    ).get(transactionId);

    if (!txn) {
      return { audit_trail_id: null, entries: [], summary: null, message: 'Transaction not found' };
    }

    return this.getByAuditTrailId(txn.audit_trail_id);
  }

  /**
   * Get all audit activity for a specific agent.
   * 
   * @param {string} agentId
   * @param {Object} [options]
   * @param {number} [options.limit=50] - Max entries to return
   * @param {string} [options.step] - Filter by step type
   * @returns {Object} Agent audit history
   */
  getByAgentId(agentId, { limit = 50, step } = {}) {
    let query = `
      SELECT ae.* FROM audit_entries ae
      WHERE ae.audit_trail_id IN (
        SELECT DISTINCT audit_trail_id FROM transactions WHERE agent_id = ?
      )
    `;
    const params = [agentId];

    if (step) {
      query += ' AND ae.step = ?';
      params.push(step);
    }

    query += ' ORDER BY ae.timestamp DESC LIMIT ?';
    params.push(limit);

    const entries = this.db.prepare(query).all(...params);

    // Group by audit_trail_id
    const trails = {};
    for (const entry of entries) {
      if (!trails[entry.audit_trail_id]) {
        trails[entry.audit_trail_id] = [];
      }
      trails[entry.audit_trail_id].push(this._formatEntry(entry));
    }

    return {
      agent_id: agentId,
      total_entries: entries.length,
      trails,
    };
  }

  /**
   * Get a summary of all audit trails (recent transactions with step counts).
   * 
   * @param {Object} [options]
   * @param {number} [options.limit=20] - Max trails to return
   * @returns {Object[]} Array of trail summaries
   */
  getSummary({ limit = 20 } = {}) {
    const trails = this.db.prepare(`
      SELECT 
        ae.audit_trail_id,
        COUNT(*) as total_entries,
        MIN(ae.timestamp) as first_event,
        MAX(ae.timestamp) as last_event,
        GROUP_CONCAT(DISTINCT ae.step) as steps,
        t.transaction_id,
        t.status as transaction_status,
        t.total_amount,
        t.agent_id,
        t.delegator_id
      FROM audit_entries ae
      LEFT JOIN transactions t ON t.audit_trail_id = ae.audit_trail_id
      GROUP BY ae.audit_trail_id
      ORDER BY ae.audit_trail_id DESC
      LIMIT ?
    `).all(limit);

    return trails.map((trail) => ({
      audit_trail_id: trail.audit_trail_id,
      transaction_id: trail.transaction_id,
      transaction_status: trail.transaction_status,
      total_amount: trail.total_amount,
      agent_id: trail.agent_id,
      delegator_id: trail.delegator_id,
      total_entries: trail.total_entries,
      steps: trail.steps ? trail.steps.split(',') : [],
      first_event: trail.first_event,
      last_event: trail.last_event,
    }));
  }

  // ════════════════════════════════════════════════════════════════════
  //  PRIVATE HELPERS
  // ════════════════════════════════════════════════════════════════════

  /**
   * Format a raw audit trail with entries and computed summary.
   * @private
   */
  _formatTrail(auditTrailId, entries) {
    const formatted = entries.map((e) => this._formatEntry(e));

    // Build step summary
    const stepCounts = {};
    for (const entry of formatted) {
      stepCounts[entry.step] = (stepCounts[entry.step] || 0) + 1;
    }

    // Find the linked transaction
    const txn = this.db.prepare(
      'SELECT transaction_id, status, total_amount, agent_id, delegator_id FROM transactions WHERE audit_trail_id = ?'
    ).get(auditTrailId);

    return {
      audit_trail_id: auditTrailId,
      transaction: txn ? {
        transaction_id: txn.transaction_id,
        status: txn.status,
        total_amount: txn.total_amount,
        total_display: txn.total_amount ? `₹${(txn.total_amount / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })}` : null,
        agent_id: txn.agent_id,
        delegator_id: txn.delegator_id,
      } : null,
      total_entries: formatted.length,
      steps: stepCounts,
      timeline: formatted,
    };
  }

  /**
   * Format a single audit entry.
   * @private
   */
  _formatEntry(row) {
    let data;
    try {
      data = typeof row.data === 'string' ? JSON.parse(row.data) : row.data;
    } catch {
      data = row.data;
    }

    return {
      entry_id: row.entry_id,
      audit_trail_id: row.audit_trail_id,
      step: row.step,
      timestamp: row.timestamp,
      data,
    };
  }
}

module.exports = AuditService;
