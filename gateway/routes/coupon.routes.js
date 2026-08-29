/**
 * @module gateway/routes/coupon.routes
 * @description Coupon & Voucher API routes for ACG v2 (Phase 11).
 *
 * Public endpoints (no agent auth required — they expose read-only
 * or pre-purchase info that the agent needs before checkout):
 *
 *   GET  /api/v1/coupons           — List active coupons for a merchant
 *   POST /api/v1/coupons/validate  — Validate a code without consuming it
 *   POST /api/v1/coupons/apply     — Validate + increment usage counter
 *
 * All endpoints use Zod validation and return structured error payloads.
 *
 * @see docs/ticket_03_coupon_and_voucher_system.md Section 2.3
 * @see gateway/services/coupon.service.js
 */

const { Router } = require('express');
const { z }      = require('zod');
const { validate } = require('../middleware/validate.middleware');
const logger       = require('../../lib/logger');

// ── Zod Schemas ──────────────────────────────────────────────────

/**
 * Common coupon action body — used by both /validate and /apply.
 */
const couponActionSchema = z.object({
  code: z
    .string()
    .min(1, 'Coupon code is required')
    .max(50, 'Coupon code too long')
    .transform(s => s.trim().toUpperCase()),

  merchant_id: z
    .string()
    .min(1, 'merchant_id is required'),

  amount: z.coerce
    .number()
    .int('amount must be an integer (paise)')
    .positive('amount must be positive'),

  category: z.string().optional(),

  audit_trail_id: z.string().optional(),
});

/**
 * List coupons query schema.
 */
const listCouponsSchema = z.object({
  merchant_id: z.string().min(1, 'merchant_id is required'),
  category:    z.string().optional(),
  amount: z.coerce
    .number()
    .int()
    .positive()
    .optional(),
});

// ── Route Factory ────────────────────────────────────────────────

/**
 * Create coupon routes with injected CouponService.
 *
 * @param {import('../services/coupon.service')} couponService
 * @returns {Router} Express router with coupon endpoints
 */
function createCouponRoutes(couponService) {
  const router = Router();

  /**
   * GET /api/v1/coupons?merchant_id=...&category=...&amount=...
   *
   * Returns all active, non-expired coupons for a merchant.
   * Optionally filters by category and minimum order amount.
   *
   * Response 200:
   * {
   *   status: "success",
   *   data: {
   *     merchant_id: "...",
   *     total: 3,
   *     coupons: [ CouponObject, ... ]
   *   }
   * }
   */
  router.get(
    '/',
    validate(listCouponsSchema, 'query'),
    (req, res, next) => {
      try {
        const { merchant_id, category, amount } = req.query;

        logger.info('[CouponRoute] GET /coupons', {
          merchant_id, category, amount, trace_id: req.traceId,
        });

        const coupons = couponService.listCoupons({ merchant_id, category, amount });

        res.json({
          status: 'success',
          data: {
            merchant_id,
            total: coupons.length,
            coupons,
          },
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
   * POST /api/v1/coupons/validate
   *
   * Validates a coupon code against the purchase context WITHOUT
   * consuming it (times_used is NOT incremented). Useful for
   * showing the user the discount before they confirm.
   *
   * Body:
   *   code        {string}  required — Coupon code (case-insensitive)
   *   merchant_id {string}  required — Merchant the coupon belongs to
   *   amount      {number}  required — Cart total in paise (before discount)
   *   category    {string}  optional — Product category for eligibility check
   *   audit_trail_id {string} optional — For audit correlation
   *
   * Response 200:
   * {
   *   status: "success",
   *   data: {
   *     valid: true,
   *     coupon: CouponObject,
   *     original_amount:  429900,
   *     original_display: "₹4,299.00",
   *     discount_amount:   50000,
   *     discount_display: "₹500.00",
   *     final_amount:     379900,
   *     final_display:    "₹3,799.00"
   *   }
   * }
   */
  router.post(
    '/validate',
    validate(couponActionSchema, 'body'),
    (req, res, next) => {
      try {
        const { code, merchant_id, amount, category, audit_trail_id } = req.body;

        logger.info('[CouponRoute] POST /coupons/validate', {
          code, merchant_id, amount, category, trace_id: req.traceId,
        });

        const result = couponService.validateCoupon({
          code, merchant_id, amount, category,
          audit_trail_id: audit_trail_id || req.traceId,
        });

        res.json({
          status: 'success',
          data: result,
          meta: {
            timestamp: new Date().toISOString(),
            ...(req.traceId && { trace_id: req.traceId }),
          },
        });
      } catch (err) {
        // Coupon errors are domain errors — pass to error handler
        next(err);
      }
    }
  );

  /**
   * POST /api/v1/coupons/apply
   *
   * Validates the coupon AND atomically increments its usage counter.
   * Call this only when the user has confirmed they want to use the coupon.
   *
   * Body: same as /validate
   *
   * Response 200:
   * {
   *   status: "success",
   *   data: {
   *     applied: true,
   *     coupon: CouponObject,
   *     original_amount:  ...,
   *     discount_amount:  ...,
   *     final_amount:     ...
   *   }
   * }
   */
  router.post(
    '/apply',
    validate(couponActionSchema, 'body'),
    (req, res, next) => {
      try {
        const { code, merchant_id, amount, category, audit_trail_id } = req.body;

        logger.info('[CouponRoute] POST /coupons/apply', {
          code, merchant_id, amount, category, trace_id: req.traceId,
        });

        const result = couponService.applyCoupon({
          code, merchant_id, amount, category,
          audit_trail_id: audit_trail_id || req.traceId,
        });

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
    }
  );

  return router;
}

module.exports = createCouponRoutes;
