/**
 * @module gateway/routes/mandate.routes
 * @description Mandate API routes for the Agentic Commerce Gateway.
 * 
 * Exposes the mandate lifecycle as REST endpoints:
 *   POST /intent     — Human creates a spending mandate
 *   POST /cart       — Agent submits a cart for approval
 *   POST /cart/:id/approve — Human approves the cart
 *   POST /cart/:id/reject  — Human rejects the cart
 *   GET  /:id        — Get mandate details
 *   GET  /:id/chain  — Get full mandate chain
 * 
 * @see docs/TRD.md Section 4 — Mandate API
 */

const { Router } = require('express');
const { z } = require('zod');
const { validate } = require('../middleware/validate.middleware');

// ── Zod Schemas ─────────────────────────────────────────────────────

const createIntentSchema = z.object({
  delegator_id: z.string().min(1, 'delegator_id is required'),
  agent_id: z.string().min(1, 'agent_id is required'),
  constraints: z.object({
    max_amount: z.number().int().positive('max_amount must be a positive integer (paise)'),
    currency: z.string().default('INR'),
    allowed_categories: z.array(z.string()).optional().default([]),
    allowed_merchants: z.array(z.string()).optional().default([]),
    single_use: z.boolean().optional().default(true),
  }),
  ttl: z.number().int().positive().optional().default(3600),
});

const createCartSchema = z.object({
  intent_mandate_id: z.string().min(1, 'intent_mandate_id is required'),
  agent_id: z.string().min(1, 'agent_id is required'),
  items: z.array(z.object({
    product_id: z.string().min(1),
    variant_id: z.string().optional(),
    quantity: z.number().int().positive().optional().default(1),
  })).min(1, 'At least one item is required'),
  reasoning: z.object({
    query: z.string().optional(),
    reason: z.string().optional(),
    alternatives: z.array(z.object({
      product_id: z.string(),
      reason: z.string(),
    })).optional(),
  }).optional(),
});

const approveCartSchema = z.object({
  approved_by: z.string().min(1, 'approved_by is required'),
});

const rejectCartSchema = z.object({
  rejected_by: z.string().min(1, 'rejected_by is required'),
  reason: z.string().optional().default(''),
});

const mandateIdSchema = z.object({
  id: z.string().min(1, 'Mandate ID is required'),
});

// ── Route Factory ───────────────────────────────────────────────────

/**
 * Create mandate routes with an injected MandateService instance.
 * 
 * @param {import('../services/mandate.service')} mandateService - Mandate service instance
 * @returns {Router} Express router with mandate endpoints
 */
function createMandateRoutes(mandateService) {
  const router = Router();

  /**
   * POST /api/v1/mandates/intent
   * 
   * Human creates a spending mandate with constraints.
   * This is the entry point to the mandate chain.
   */
  router.post('/intent', validate(createIntentSchema, 'body'), (req, res, next) => {
    try {
      const mandate = mandateService.createIntentMandate(req.body);

      res.status(201).json({
        status: 'success',
        message: 'Intent mandate created. Agent can now search and select products within these constraints.',
        data: mandate,
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
   * POST /api/v1/mandates/cart
   * 
   * Agent submits a cart for human approval.
   * Validates items against the parent intent's constraints.
   * Returns PENDING_APPROVAL status — human must approve before payment.
   */
  router.post('/cart', validate(createCartSchema, 'body'), (req, res, next) => {
    try {
      const mandate = mandateService.createCartMandate(req.body);

      res.status(201).json({
        status: 'success',
        message: 'Cart mandate created. Awaiting human approval.',
        data: mandate,
        meta: {
          timestamp: new Date().toISOString(),
          trace_id: req.traceId,
          next_step: 'POST /api/v1/mandates/cart/:id/approve or /reject',
        },
      });
    } catch (err) {
      next(err);
    }
  });

  /**
   * POST /api/v1/mandates/cart/:id/approve
   * 
   * Human approves the cart → creates a Payment Mandate.
   * Returns the one-time-use payment mandate token.
   */
  router.post('/cart/:id/approve',
    validate(mandateIdSchema, 'params'),
    validate(approveCartSchema, 'body'),
    (req, res, next) => {
      try {
        const paymentMandate = mandateService.approveCartMandate(
          req.params.id,
          req.body.approved_by
        );

        res.json({
          status: 'success',
          message: 'Cart approved. Payment mandate issued — use the token to execute payment.',
          data: paymentMandate,
          meta: {
            timestamp: new Date().toISOString(),
            trace_id: req.traceId,
            next_step: 'POST /api/v1/payments/execute (with payment mandate token)',
          },
        });
      } catch (err) {
        next(err);
      }
    }
  );

  /**
   * POST /api/v1/mandates/cart/:id/reject
   * 
   * Human rejects the cart. Agent should revise selections.
   */
  router.post('/cart/:id/reject',
    validate(mandateIdSchema, 'params'),
    validate(rejectCartSchema, 'body'),
    (req, res, next) => {
      try {
        const mandate = mandateService.rejectCartMandate(
          req.params.id,
          req.body.rejected_by,
          req.body.reason
        );

        res.json({
          status: 'success',
          message: 'Cart rejected. Agent should revise the selection.',
          data: mandate,
          meta: {
            timestamp: new Date().toISOString(),
            trace_id: req.traceId,
          },
        });
      } catch (err) {
        next(err);
      }
    }
  );

  /**
   * GET /api/v1/mandates/:id
   * 
   * Get mandate details by ID.
   */
  router.get('/:id', validate(mandateIdSchema, 'params'), (req, res, next) => {
    try {
      const mandate = mandateService.getMandateById(req.params.id);

      res.json({
        status: 'success',
        data: mandate,
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
   * GET /api/v1/mandates/:id/chain
   * 
   * Get the full mandate chain (INTENT → CART → PAYMENT) for a mandate.
   */
  router.get('/:id/chain', validate(mandateIdSchema, 'params'), (req, res, next) => {
    try {
      const chain = mandateService.getMandateChain(req.params.id);

      res.json({
        status: 'success',
        data: chain,
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

module.exports = createMandateRoutes;
