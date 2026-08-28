/**
 * @module gateway/routes/recommendation.routes
 * @description Recommendation & Comparison API routes for ACG v2.
 *
 * Exposes:
 *   POST /api/v1/recommendations/decide   — Full recommendation pipeline
 *   POST /api/v1/recommendations/compare  — Side-by-side comparison by product IDs
 *
 * Both endpoints are public (no agent authentication required) so the
 * reasoning layer can call them freely during the discovery phase.
 *
 * @see docs/TRD.md Section 3 — Recommendation & Comparison Algorithms
 * @see docs/ticket_02_recommendation_and_comparison.md Section 2.3
 */

const { Router } = require('express');
const { z }      = require('zod');
const { validate } = require('../middleware/validate.middleware');
const logger       = require('../../lib/logger');

// ── Zod Schemas ──────────────────────────────────────────────────────

/**
 * Schema for POST /decide
 * Mirrors the discovery search parameters so the agent can run both
 * steps in one round-trip.
 */
const decideSchema = z.object({
  q: z
    .string()
    .min(1, 'Search query `q` is required')
    .max(200, 'Search query too long'),

  max_price: z.coerce
    .number()
    .int('max_price must be an integer (paise)')
    .positive('max_price must be positive')
    .optional(),

  category: z.string().optional(),

  limit: z.coerce
    .number()
    .int()
    .positive()
    .max(20, 'limit cannot exceed 20 for recommendations')
    .default(8),

  local_only: z.boolean().optional().default(false),
});

/**
 * Schema for POST /compare
 * Accepts a list of product IDs (local or external) and optional intent context.
 */
const compareSchema = z.object({
  product_ids: z
    .array(z.string().min(1))
    .min(1, 'At least one product_id is required')
    .max(10, 'Cannot compare more than 10 products at once'),

  intent: z.object({
    max_price:  z.coerce.number().int().positive().optional(),
    category:   z.string().optional(),
    raw_prompt: z.string().optional(),
    keywords:   z.array(z.string()).optional(),
  }).optional().default({}),
});

// ── Route Factory ────────────────────────────────────────────────────

/**
 * Create recommendation routes with injected RecommendationService.
 *
 * @param {import('../services/recommendation.service')} recommendationService
 * @returns {Router} Express router with recommendation endpoints
 */
function createRecommendationRoutes(recommendationService) {
  const router = Router();

  /**
   * POST /api/v1/recommendations/decide
   *
   * Full pipeline: discover products → score candidates → produce ranked
   * recommendation with natural-language justification + comparison matrix.
   *
   * Body:
   *   q           {string}  required — search keywords
   *   max_price   {number}  optional — budget ceiling (paise)
   *   category    {string}  optional — category slug
   *   limit       {number}  optional — max candidates [1-20], default 8
   *   local_only  {boolean} optional — skip external web
   *
   * Response 200:
   * {
   *   status: "success",
   *   data: {
   *     decision:    DecisionResult,
   *     comparison:  ComparisonMatrix,
   *     meta:        { query, sources_queried, total_discovered, ... }
   *   }
   * }
   */
  router.post(
    '/decide',
    validate(decideSchema, 'body'),
    async (req, res, next) => {
      try {
        const { q, max_price, category, limit, local_only } = req.body;

        logger.info('[RecommendationRoute] POST /decide', {
          q, max_price, category, limit, local_only,
          trace_id: req.traceId,
        });

        const result = await recommendationService.recommend({
          q, max_price, category, limit, local_only,
        });

        res.json({
          status: 'success',
          data:   result,
          meta: {
            timestamp: new Date().toISOString(),
            ...(req.traceId && { trace_id: req.traceId }),
          },
        });
      } catch (err) {
        next(err);
      }
    }
  );

  /**
   * POST /api/v1/recommendations/compare
   *
   * Generates a side-by-side comparison matrix for a specific list of
   * product IDs that were previously discovered.
   *
   * Body:
   *   product_ids {string[]} required — product IDs (local or external)
   *   intent      {object}   optional — { max_price, category, raw_prompt }
   *
   * Response 200:
   * {
   *   status: "success",
   *   data: ComparisonMatrix
   * }
   */
  router.post(
    '/compare',
    validate(compareSchema, 'body'),
    async (req, res, next) => {
      try {
        const { product_ids, intent } = req.body;

        logger.info('[RecommendationRoute] POST /compare', {
          product_ids,
          intent,
          trace_id: req.traceId,
        });

        const comparison = await recommendationService.compareById({
          product_ids,
          intent,
        });

        res.json({
          status: 'success',
          data: comparison,
          meta: {
            timestamp: new Date().toISOString(),
            ...(req.traceId && { trace_id: req.traceId }),
          },
        });
      } catch (err) {
        next(err);
      }
    }
  );

  return router;
}

module.exports = createRecommendationRoutes;
