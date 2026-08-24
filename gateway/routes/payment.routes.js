/**
 * @module gateway/routes/payment.routes
 * @description Payment API routes for the Agentic Commerce Gateway.
 * 
 * Exposes the payment execution lifecycle:
 *   POST /execute  — Execute payment using Payment Mandate token
 *   GET  /:id      — Get transaction details
 * 
 * @see docs/TRD.md Section 5 — Payment Gateway Integration
 */

const { Router } = require('express');
const { z } = require('zod');
const { validate } = require('../middleware/validate.middleware');

// ── Zod Schemas ─────────────────────────────────────────────────────

const executePaymentSchema = z.object({
  payment_mandate_id: z.string().min(1, 'payment_mandate_id is required'),
  agent_id: z.string().min(1, 'agent_id is required'),
  payment_method: z.enum(['upi', 'card', 'netbanking', 'wallet']).optional().default('upi'),
});

const transactionIdSchema = z.object({
  id: z.string().min(1, 'Transaction ID is required'),
});

// ── Route Factory ───────────────────────────────────────────────────

/**
 * Create payment routes with an injected PaymentService instance.
 * 
 * @param {import('../services/payment.service')} paymentService - Payment service instance
 * @returns {Router} Express router with payment endpoints
 */
function createPaymentRoutes(paymentService) {
  const router = Router();

  /**
   * POST /api/v1/payments/execute
   * 
   * Execute a payment using a Payment Mandate token.
   * This is the terminal action in the mandate chain.
   * 
   * Flow:
   * 1. Validates payment mandate (JWT, expiry, single-use)
   * 2. Validates mandate chain integrity
   * 3. Re-checks stock and prices
   * 4. Creates Razorpay order
   * 5. Captures payment
   * 6. Decrements inventory
   * 7. Returns transaction result
   */
  router.post('/execute', validate(executePaymentSchema, 'body'), async (req, res, next) => {
    try {
      const transaction = await paymentService.executePayment(req.body);

      res.status(201).json({
        status: 'success',
        message: 'Payment executed successfully. Transaction completed.',
        data: transaction,
        meta: {
          timestamp: new Date().toISOString(),
          trace_id: req.traceId,
        },
      });
    } catch (err) {
      next(err);
    }
  });

  /**
   * GET /api/v1/payments/:id
   * 
   * Get transaction details by transaction ID.
   */
  router.get('/:id', validate(transactionIdSchema, 'params'), (req, res, next) => {
    try {
      const transaction = paymentService.getTransaction(req.params.id);

      res.json({
        status: 'success',
        data: transaction,
        meta: {
          timestamp: new Date().toISOString(),
          trace_id: req.traceId,
        },
      });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

module.exports = createPaymentRoutes;
