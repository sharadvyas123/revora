/**
 * @module gateway/services/payment.service
 * @description Payment orchestration service for the Agentic Commerce Gateway.
 * 
 * Implements the full payment lifecycle:
 * 1. Verify Payment Mandate token (JWT signature, expiry, single-use)
 * 2. Validate the mandate chain (Intent → Cart → Payment integrity)
 * 3. Re-validate stock and price (optimistic locking)
 * 4. Create Razorpay order
 * 5. Simulate/capture payment
 * 6. Update inventory (decrement stock)
 * 7. Mark mandate as USED and transaction as CAPTURED
 * 
 * On failure at any point:
 * - Roll back stock changes
 * - Mark transaction as FAILED with reason
 * - Return structured error with recovery suggestion
 * 
 * @see docs/TRD.md Section 5 — Payment Gateway Integration
 * @see docs/design.md Section 4 — Payment Safety
 * @see docs/PRD.md Section 5 — F3: Payment Orchestration
 */

const { v4: uuidv4 } = require('uuid');
const logger = require('../../lib/logger');
const { verifyMandateToken } = require('../../lib/jwt');
const {
  MandateExpiredError,
  MandateUsedError,
  ChainBrokenError,
  InvalidStateTransitionError,
  ConfirmationRequiredError,
  OutOfStockError,
  StockChangedError,
  PriceChangedError,
  PaymentFailedError,
} = require('../../lib/errors');

class PaymentService {
  /**
   * @param {import('better-sqlite3').Database} db - SQLite database instance
   * @param {import('../../lib/razorpay')} razorpay - RazorpayWrapper instance
   * @param {import('./audit.service')} [auditService] - Optional AuditService instance
   */
  constructor(db, razorpay, auditService) {
    this.db = db;
    this.razorpay = razorpay;
    this.auditService = auditService || null;
  }

  /**
   * Execute a payment using a Payment Mandate token.
   * 
   * This is the terminal step of the mandate chain:
   *   Intent → Cart → Approval → Payment Mandate → **Execute**
   * 
   * @param {Object} params
   * @param {string} params.payment_mandate_id - Payment mandate ID
   * @param {string} params.agent_id - Agent executing the payment
   * @param {string} [params.payment_method='upi'] - Payment method (test mode)
   * @returns {Object} Transaction result with Razorpay order/payment IDs
   */
  async executePayment({ payment_mandate_id, agent_id, payment_method = 'upi' }) {
    const transactionId = `txn_${uuidv4().split('-')[0]}`;
    let auditTrailId = `audit_${uuidv4().split('-')[0]}`;

    try {
      logger.info('Payment execution started', {
        transaction_id: transactionId,
        payment_mandate_id,
        agent_id,
      });

      // ── Step 1: Load and validate Payment Mandate ───────────────────
      const paymentMandate = this.db.prepare(
        'SELECT * FROM mandates WHERE mandate_id = ? AND type = ?'
      ).get(payment_mandate_id, 'PAYMENT');

      if (!paymentMandate) {
        throw new ChainBrokenError(payment_mandate_id, 'not_found');
      }

      // Try to resolve the root intent mandate ID to use as the audit trail ID
      const cartMandateTemp = this.db.prepare(
        'SELECT parent_mandate_id FROM mandates WHERE mandate_id = ?'
      ).get(paymentMandate.parent_mandate_id);
      if (cartMandateTemp) {
        auditTrailId = cartMandateTemp.parent_mandate_id;
      }

      // Check expiry
      if (new Date() > new Date(paymentMandate.expires_at)) {
        this.db.prepare("UPDATE mandates SET status = 'EXPIRED' WHERE mandate_id = ?")
          .run(payment_mandate_id);
        throw new MandateExpiredError(payment_mandate_id);
      }

      // Check single-use
      if (paymentMandate.status === 'USED') {
        throw new MandateUsedError(payment_mandate_id);
      }

      if (paymentMandate.status !== 'AUTHORIZED') {
        throw new InvalidStateTransitionError('mandate', payment_mandate_id, paymentMandate.status, 'USED');
      }

      // Verify JWT token
      const tokenClaims = verifyMandateToken(paymentMandate.token);

      // Verify agent matches
      if (tokenClaims.agent_id !== agent_id) {
        throw new PaymentFailedError('Agent ID does not match the payment mandate');
      }

      // ── Step 2: Validate the full mandate chain ─────────────────────
      const cartMandate = this.db.prepare(
        'SELECT * FROM mandates WHERE mandate_id = ? AND type = ?'
      ).get(paymentMandate.parent_mandate_id, 'CART');

      if (!cartMandate || cartMandate.status !== 'APPROVED') {
        throw new ChainBrokenError(payment_mandate_id, paymentMandate.parent_mandate_id);
      }

      const intentMandate = this.db.prepare(
        'SELECT * FROM mandates WHERE mandate_id = ? AND type = ?'
      ).get(cartMandate.parent_mandate_id, 'INTENT');

      if (!intentMandate) {
        throw new ChainBrokenError(payment_mandate_id, cartMandate.parent_mandate_id);
      }

      // Ensure we have the resolved intent mandate ID
      auditTrailId = intentMandate.mandate_id;

      // ── Step 2b: Enforce Explicit Purchase Confirmation Gate ────────
      // Cart mandate must have confirmation_status === 'EXPLICIT_CONFIRMED'
      // before any payment is allowed.
      const confirmationStatus = cartMandate.confirmation_status || 'PENDING';
      if (confirmationStatus !== 'EXPLICIT_CONFIRMED') {
        throw new ConfirmationRequiredError(cartMandate.mandate_id);
      }

      // ── Step 3: Re-validate stock and prices ────────────────────────
      const items = JSON.parse(paymentMandate.items);
      const constraints = JSON.parse(paymentMandate.constraints);
      let totalAmount = 0;

      for (const item of items) {
        const product = this.db.prepare('SELECT * FROM products WHERE product_id = ?')
          .get(item.product_id);

        if (!product) {
          throw new PaymentFailedError(`Product ${item.product_id} no longer exists`);
        }

        // Check stock availability
        if (!product.stock_available || product.stock_quantity < item.quantity) {
          throw new OutOfStockError(item.product_id, item.variant_id);
        }

        // Check if variant has stock
        if (item.variant_id) {
          const variant = this.db.prepare(
            'SELECT * FROM variants WHERE variant_id = ? AND product_id = ?'
          ).get(item.variant_id, item.product_id);

          if (variant && variant.stock_quantity < item.quantity) {
            throw new OutOfStockError(item.product_id, item.variant_id);
          }
        }

        // Verify price hasn't changed
        const currentPrice = product.price_amount;
        if (currentPrice !== item.unit_price) {
          throw new PriceChangedError(item.product_id, item.unit_price, currentPrice);
        }

        totalAmount += item.unit_price * item.quantity;
      }

      // Verify total matches mandate's exact_amount
      if (constraints.exact_amount && totalAmount !== constraints.exact_amount) {
        throw new PaymentFailedError(
          `Cart total ${totalAmount} does not match mandated amount ${constraints.exact_amount}`
        );
      }

      // ── Step 4: Create transaction record (INITIATED) ───────────────
      this.db.prepare(`
        INSERT INTO transactions (
          transaction_id, status, intent_mandate_id, cart_mandate_id, payment_mandate_id,
          agent_id, delegator_id, merchant_id, items, total_amount, currency,
          audit_trail_id, created_at
        ) VALUES (?, 'INITIATED', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        transactionId,
        intentMandate.mandate_id,
        cartMandate.mandate_id,
        paymentMandate.mandate_id,
        agent_id,
        paymentMandate.delegator_id,
        paymentMandate.merchant_id,
        JSON.stringify(items),
        totalAmount,
        constraints.currency || 'INR',
        auditTrailId,
        new Date().toISOString()
      );

      // ── Step 5: Create Razorpay order ───────────────────────────────
      let razorpayOrder;
      try {
        razorpayOrder = await this.razorpay.createOrder({
          amount: totalAmount,
          currency: constraints.currency || 'INR',
          receipt: transactionId,
          notes: {
            transaction_id: transactionId,
            mandate_id: payment_mandate_id,
            agent_id,
            delegator_id: paymentMandate.delegator_id,
          },
        });

        // Update transaction with Razorpay order ID
        this.db.prepare(`
          UPDATE transactions SET status = 'PAYMENT_PENDING', razorpay_order_id = ?
          WHERE transaction_id = ?
        `).run(razorpayOrder.id, transactionId);

      } catch (err) {
        // Order creation failed — mark transaction as failed
        this._failTransaction(transactionId, `Razorpay order creation failed: ${err.message}`, auditTrailId);
        throw err;
      }

      // ── Step 6: Simulate payment capture (test mode) ────────────────
      let razorpayPayment;
      try {
        const paymentId = `pay_sim_${uuidv4().split('-')[0]}`;
        razorpayPayment = await this.razorpay.capturePayment(paymentId, totalAmount, constraints.currency || 'INR');

        // Generate a simulated signature
        const signature = crypto_createSimSignature(razorpayOrder.id, razorpayPayment.id, this.razorpay.keySecret);

        // Verify signature (always passes in simulation, validates in live mode)
        this.razorpay.verifyPaymentSignature({
          razorpay_order_id: razorpayOrder.id,
          razorpay_payment_id: razorpayPayment.id,
          razorpay_signature: signature,
        });

      } catch (err) {
        // Payment failed — rollback
        this._failTransaction(transactionId, `Payment capture failed: ${err.message}`, auditTrailId);
        throw new PaymentFailedError(`Payment failed: ${err.message}`, razorpayOrder.id);
      }

      // Log the PAYMENT step
      if (this.auditService) {
        this.auditService.logPayment(auditTrailId, {
          transaction_id: transactionId,
          razorpay_order_id: razorpayOrder.id,
          razorpay_payment_id: razorpayPayment.id,
          amount: totalAmount,
          currency: constraints.currency || 'INR',
          status: 'CAPTURED',
        });
      }

      // ── Step 7: Decrement inventory (optimistic locking) ────────────
      const decrementStock = this.db.transaction(() => {
        for (const item of items) {
          // Decrement product stock
          const result = this.db.prepare(`
            UPDATE products SET 
              stock_quantity = stock_quantity - ?,
              stock_available = CASE WHEN stock_quantity - ? > 0 THEN 1 ELSE 0 END
            WHERE product_id = ? AND stock_quantity >= ?
          `).run(item.quantity, item.quantity, item.product_id, item.quantity);

          if (result.changes === 0) {
            throw new StockChangedError(item.product_id, item.quantity, 0);
          }

          // Decrement variant stock if applicable
          if (item.variant_id) {
            this.db.prepare(`
              UPDATE variants SET
                stock_quantity = stock_quantity - ?,
                stock_available = CASE WHEN stock_quantity - ? > 0 THEN 1 ELSE 0 END
              WHERE variant_id = ? AND stock_quantity >= ?
            `).run(item.quantity, item.quantity, item.variant_id, item.quantity);
          }
        }
      });

      try {
        decrementStock();
      } catch (err) {
        // Stock decrement failed — rollback transaction
        this._failTransaction(transactionId, `Stock update failed: ${err.message}`, auditTrailId);
        throw err;
      }

      // ── Step 8: Mark everything as complete ─────────────────────────
      const now = new Date().toISOString();

      // Update transaction → CAPTURED
      this.db.prepare(`
        UPDATE transactions SET
          status = 'CAPTURED',
          razorpay_payment_id = ?,
          razorpay_signature = ?,
          completed_at = ?
        WHERE transaction_id = ?
      `).run(
        razorpayPayment.id,
        'sim_signature',
        now,
        transactionId
      );

      // Mark payment mandate as USED
      this.db.prepare(`
        UPDATE mandates SET status = 'USED', used_at = ?
        WHERE mandate_id = ?
      `).run(now, payment_mandate_id);

      logger.info('Payment execution completed', {
        transaction_id: transactionId,
        razorpay_order_id: razorpayOrder.id,
        razorpay_payment_id: razorpayPayment.id,
        total_amount: totalAmount,
        status: 'CAPTURED',
      });

      // Log the OUTCOME step
      if (this.auditService) {
        this.auditService.logOutcome(auditTrailId, {
          transaction_id: transactionId,
          status: 'CAPTURED',
          total_amount: totalAmount,
          items_count: items.length,
        });
      }

      // ── Return formatted result ─────────────────────────────────────
      return this._formatTransaction(
        this.db.prepare('SELECT * FROM transactions WHERE transaction_id = ?').get(transactionId)
      );

    } catch (err) {
      // Outer catch to log unhandled/validation errors to audit log
      if (this.auditService) {
        this.auditService.logError(auditTrailId, {
          step_context: 'executePayment',
          error_code: err.code || 'INTERNAL_ERROR',
          error_message: err.message,
          stack: err.stack,
        });

        // If transaction was not successfully created or was rolled back
        const hasTxn = this.db.prepare('SELECT 1 FROM transactions WHERE transaction_id = ?').get(transactionId);
        if (!hasTxn) {
          this.auditService.logOutcome(auditTrailId, {
            transaction_id: transactionId,
            status: 'FAILED',
            total_amount: 0,
            items_count: 0,
            failure_reason: err.message,
          });
        }
      }
      throw err;
    }
  }

  /**
   * Get a transaction by ID.
   * 
   * @param {string} transactionId
   * @returns {Object} Formatted transaction
   */
  getTransaction(transactionId) {
    const txn = this.db.prepare('SELECT * FROM transactions WHERE transaction_id = ?')
      .get(transactionId);

    if (!txn) {
      throw new PaymentFailedError(`Transaction ${transactionId} not found`);
    }

    return this._formatTransaction(txn);
  }

  // ════════════════════════════════════════════════════════════════════
  //  PRIVATE HELPERS
  // ════════════════════════════════════════════════════════════════════

  /**
   * Mark a transaction as FAILED with a reason.
   * @param {string} transactionId
   * @param {string} reason
   * @param {string} [auditTrailId]
   * @private
   */
  _failTransaction(transactionId, reason, auditTrailId) {
    this.db.prepare(`
      UPDATE transactions SET status = 'FAILED', failure_reason = ?, completed_at = ?
      WHERE transaction_id = ?
    `).run(reason, new Date().toISOString(), transactionId);

    logger.error('Transaction failed', { transaction_id: transactionId, reason });

    if (auditTrailId && this.auditService) {
      this.auditService.logOutcome(auditTrailId, {
        transaction_id: transactionId,
        status: 'FAILED',
        total_amount: 0,
        items_count: 0,
        failure_reason: reason,
      });
      this.auditService.logError(auditTrailId, {
        step_context: 'executePayment',
        error_code: 'PAYMENT_FAILED',
        error_message: reason,
      });
    }
  }

  /**
   * Format a raw transaction row for API response.
   * @param {Object} row
   * @returns {Object}
   * @private
   */
  _formatTransaction(row) {
    const items = safeJSON(row.items, []);
    const totalDisplay = `₹${(row.total_amount / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;

    return {
      transaction_id: row.transaction_id,
      status: row.status,
      mandate_chain: {
        intent: row.intent_mandate_id,
        cart: row.cart_mandate_id,
        payment: row.payment_mandate_id,
      },
      agent_id: row.agent_id,
      delegator_id: row.delegator_id,
      merchant_id: row.merchant_id,
      order: {
        items,
        total_amount: row.total_amount,
        total_display: totalDisplay,
        currency: row.currency,
      },
      razorpay: {
        order_id: row.razorpay_order_id || null,
        payment_id: row.razorpay_payment_id || null,
        signature: row.razorpay_signature || null,
      },
      audit_trail_id: row.audit_trail_id,
      created_at: row.created_at,
      completed_at: row.completed_at || null,
      ...(row.failure_reason && { failure_reason: row.failure_reason }),
    };
  }
}

// ── Utility Functions ───────────────────────────────────────────────

function safeJSON(str, fallback) {
  if (!str) return fallback;
  try { return JSON.parse(str); } catch { return fallback; }
}

/**
 * Create a simulated signature for test/simulation mode.
 * In live mode, the real Razorpay signature is generated by the checkout.
 */
function crypto_createSimSignature(orderId, paymentId, secret) {
  const crypto = require('crypto');
  return crypto
    .createHmac('sha256', secret || 'simulation_secret')
    .update(`${orderId}|${paymentId}`)
    .digest('hex');
}

module.exports = PaymentService;
