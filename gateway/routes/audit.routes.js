/**
 * @module gateway/routes/audit.routes
 * @description Audit API routes for the Agentic Commerce Gateway.
 * 
 * Exposes read-only inspection endpoints for the immutable audit trail:
 *   GET /transactions/:id  — Full timeline for a transaction
 *   GET /trails/:trail_id  — Complete audit trail by trail ID
 *   GET /agents/:agent_id  — Historical activity for an agent
 *   GET /summary           — Overview of recent audit trails
 * 
 * @see docs/TRD.md Section 6 — Audit Trail API
 */

const { Router } = require('express');
const { z } = require('zod');
const { validate } = require('../middleware/validate.middleware');

// ── Zod Schemas ─────────────────────────────────────────────────────

const transactionIdSchema = z.object({
  id: z.string().min(1, 'Transaction ID is required'),
});

const trailIdSchema = z.object({
  trail_id: z.string().min(1, 'Audit trail ID is required'),
});

const agentIdSchema = z.object({
  agent_id: z.string().min(1, 'Agent ID is required'),
});

const summaryQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(100).optional().default(20),
});

const agentQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(100).optional().default(50),
  step: z.enum(['REQUEST', 'DISCOVERY', 'DECISION', 'MANDATE_CHECK', 'APPROVAL', 'PAYMENT', 'OUTCOME', 'ERROR']).optional(),
});

// ── Route Factory ───────────────────────────────────────────────────

/**
 * Create audit routes with an injected AuditService instance.
 * 
 * @param {import('../services/audit.service')} auditService - Audit service instance
 * @returns {Router} Express router with audit endpoints
 */
function createAuditRoutes(auditService) {
  const router = Router();

  /**
   * GET /api/v1/audit/transactions/:id
   * 
   * Get the full chronological audit timeline for a transaction.
   * Shows every step from REQUEST through OUTCOME.
   */
  router.get('/transactions/:id', validate(transactionIdSchema, 'params'), (req, res, next) => {
    try {
      const trail = auditService.getByTransactionId(req.params.id);

      res.json({
        status: 'success',
        data: trail,
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
   * GET /api/v1/audit/trails/:trail_id
   * 
   * Get a complete audit trail by its trail ID.
   */
  router.get('/trails/:trail_id', validate(trailIdSchema, 'params'), (req, res, next) => {
    try {
      const trail = auditService.getByAuditTrailId(req.params.trail_id);

      res.json({
        status: 'success',
        data: trail,
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
   * GET /api/v1/audit/agents/:agent_id
   * 
   * Get historical audit activity for a specific AI agent.
   * Supports filtering by step type.
   */
  router.get('/agents/:agent_id',
    validate(agentIdSchema, 'params'),
    validate(agentQuerySchema, 'query'),
    (req, res, next) => {
      try {
        const history = auditService.getByAgentId(req.params.agent_id, {
          limit: req.query.limit,
          step: req.query.step,
        });

        res.json({
          status: 'success',
          data: history,
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
   * GET /api/v1/audit/summary
   * 
   * Get an overview of recent audit trails with step counts and transaction status.
   */
  router.get('/summary', validate(summaryQuerySchema, 'query'), (req, res, next) => {
    try {
      const summary = auditService.getSummary({ limit: req.query.limit });

      res.json({
        status: 'success',
        data: summary,
        meta: {
          timestamp: new Date().toISOString(),
          trace_id: req.traceId,
          total: summary.length,
        },
      });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

module.exports = createAuditRoutes;
