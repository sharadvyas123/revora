/**
 * @module gateway/routes/catalog.routes
 * @description Catalog API routes for the Agentic Commerce Gateway.
 * 
 * Exposes the merchant's product catalog as a structured, machine-queryable
 * API aligned with the ACP Product Feed Specification.
 * 
 * Routes:
 *   GET /api/v1/catalog/products      — List products with filtering
 *   GET /api/v1/catalog/products/:id  — Get full product detail
 *   GET /api/v1/catalog/search        — Search with relevance scoring
 * 
 * @see docs/TRD.md Section 3.1 — Catalog API
 * @see docs/PRD.md Section 5 — F1: Agent-Readable Catalog Service
 */

const { Router } = require('express');
const { z } = require('zod');
const { validate } = require('../middleware/validate.middleware');
const logger = require('../../lib/logger');

// ── Zod Schemas for Query Validation ────────────────────────────────

/**
 * Schema for GET /products query parameters.
 * All fields optional; coerces string query params to proper types.
 */
const listProductsSchema = z.object({
  category: z.string().optional(),
  min_price: z.coerce.number().int().positive().optional(),
  max_price: z.coerce.number().int().positive().optional(),
  in_stock: z.enum(['true', 'false']).optional(),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
}).refine(
  (data) => {
    if (data.min_price && data.max_price) {
      return data.min_price <= data.max_price;
    }
    return true;
  },
  { message: 'min_price must be less than or equal to max_price' }
);

/**
 * Schema for GET /products/:id path parameters.
 */
const getProductSchema = z.object({
  id: z.string().min(1, 'Product ID is required'),
});

/**
 * Schema for GET /search query parameters.
 * Query string `q` is required; other filters are optional.
 */
const searchSchema = z.object({
  q: z.string().min(1, 'Search query is required'),
  max_price: z.coerce.number().int().positive().optional(),
  category: z.string().optional(),
  limit: z.coerce.number().int().positive().max(50).default(5),
});

// ── Route Factory ───────────────────────────────────────────────────

/**
 * Create catalog routes with an injected CatalogService instance.
 * 
 * @param {import('../services/catalog.service')} catalogService - Catalog service instance
 * @returns {Router} Express router with catalog endpoints
 */
function createCatalogRoutes(catalogService) {
  const router = Router();

  /**
   * GET /api/v1/catalog/products
   * 
   * List products with optional filtering and pagination.
   * 
   * Query params: category, min_price, max_price, in_stock, page, limit
   * Response: { products: [...], pagination: {...} }
   */
  router.get('/products', validate(listProductsSchema, 'query'), (req, res, next) => {
    try {
      const result = catalogService.findAll(req.query);

      res.json({
        status: 'success',
        data: result,
        meta: {
          timestamp: new Date().toISOString(),
          ...(req.traceId && { trace_id: req.traceId }),
        },
      });
    } catch (err) {
      next(err);
    }
  });

  /**
   * GET /api/v1/catalog/products/:id
   * 
   * Get full product detail with all variants.
   * 
   * Path params: id (product ID)
   * Response: Single product object in ACP format
   * Error: 404 PRODUCT_NOT_FOUND if product doesn't exist
   */
  router.get('/products/:id', validate(getProductSchema, 'params'), (req, res, next) => {
    try {
      const product = catalogService.findById(req.params.id);

      res.json({
        status: 'success',
        data: product,
        meta: {
          timestamp: new Date().toISOString(),
          ...(req.traceId && { trace_id: req.traceId }),
        },
      });
    } catch (err) {
      next(err);
    }
  });

  /**
   * GET /api/v1/catalog/search
   * 
   * Search products with keyword matching and relevance scoring.
   * Returns in-stock products only, ranked by relevance then rating.
   * 
   * Query params: q (required), max_price, category, limit
   * Response: { query, results: [{product, relevance_score, match_reason}], total_matches }
   */
  router.get('/search', validate(searchSchema, 'query'), (req, res, next) => {
    try {
      const result = catalogService.search(req.query);

      res.json({
        status: 'success',
        data: result,
        meta: {
          timestamp: new Date().toISOString(),
          ...(req.traceId && { trace_id: req.traceId }),
        },
      });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

module.exports = createCatalogRoutes;
