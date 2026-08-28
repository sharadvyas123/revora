/**
 * @module gateway/routes/discovery.routes
 * @description Discovery API routes for the Agentic Commerce Gateway v2.
 *
 * Provides a single endpoint for multi-source product discovery, merging
 * results from the local merchant catalog and external web sources into
 * a unified, agent-readable response.
 *
 * Routes:
 *   GET /api/v1/discovery/search  — Multi-source product search
 *
 * @see docs/TRD.md Section 3.4 — Discovery Pipeline
 * @see docs/ticket_01_multi_source_discovery.md Section 2.4
 */

const { Router } = require('express');
const { z } = require('zod');
const { validate } = require('../middleware/validate.middleware');
const logger = require('../../lib/logger');

// ── Zod Schema ──────────────────────────────────────────────────────

/**
 * Schema for GET /search query parameters.
 * `q` is the only required field; all others are optional filters.
 */
const discoverySearchSchema = z.object({
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
    .max(50, 'limit cannot exceed 50')
    .default(10),

  local_only: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
});

// ── Route Factory ───────────────────────────────────────────────────

/**
 * Create discovery routes with an injected DiscoveryService instance.
 *
 * @param {import('../services/discovery.service')} discoveryService
 * @returns {Router} Express router with discovery endpoints
 */
function createDiscoveryRoutes(discoveryService) {
  const router = Router();

  /**
   * GET /api/v1/discovery/search
   *
   * Multi-source product search across local catalog and external web.
   *
   * Query params:
   *   q           {string}  required — keywords to search
   *   max_price   {number}  optional — maximum price in paise
   *   category    {string}  optional — category slug (e.g. "footwear")
   *   limit       {number}  optional — max results [1–50], default 10
   *   local_only  {boolean} optional — skip external sources
   *
   * Response 200:
   * {
   *   status: "success",
   *   data: {
   *     query:          string,
   *     filters:        { max_price, category },
   *     total_found:    number,
   *     results:        [{ product: NormalizedProduct, relevance_score, match_source }],
   *     sources_queried: string[],
   *   },
   *   meta: { timestamp, trace_id }
   * }
   */
  router.get(
    '/search',
    validate(discoverySearchSchema, 'query'),
    (req, res, next) => {
      try {
        const {
          q,
          max_price,
          category,
          limit,
          local_only,
        } = req.query;

        logger.info('[DiscoveryRoute] GET /search', {
          q,
          max_price,
          category,
          limit,
          local_only,
          trace_id: req.traceId,
        });

        const result = discoveryService.search({
          q,
          max_price,
          category,
          limit,
          local_only,
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

  return router;
}

module.exports = createDiscoveryRoutes;
