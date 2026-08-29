/**
 * @module gateway/services/coupon.service
 * @description Coupon & Voucher Validation Engine for ACG v2 (Phase 11).
 *
 * Handles the full lifecycle of discount codes before payment authorization:
 *   1. Lookup — Find coupon by merchant + code (case-insensitive).
 *   2. Validate — Check status, date range, usage limits, category, min spend.
 *   3. Calculate — Compute discount_amount and final_amount (FLAT or PERCENTAGE).
 *   4. Apply — Increment times_used in an atomic DB transaction.
 *   5. List — Return active, applicable coupons for a given context.
 *
 * Safety guarantees:
 *   - Coupon discount is calculated BEFORE mandate spend cap check.
 *   - A coupon cannot reduce final_amount below 0.
 *   - All validation failures produce structured errors with machine-readable codes.
 *
 * @see docs/ticket_03_coupon_and_voucher_system.md
 * @see docs/TRD.md Section 5 — Coupon & Voucher Subsystem
 * @see db/migrations/002_v2_features.sql — coupons table DDL
 * @see db/migrations/003_coupon_seed.sql  — demo coupon seed data
 */

const { v4: uuidv4 } = require('uuid');
const logger = require('../../lib/logger');
const { ACGError } = require('../../lib/errors');

// ── Coupon-specific errors ────────────────────────────────────────

class CouponNotFoundError extends ACGError {
  constructor(code) {
    super(`Coupon code "${code}" not found or does not apply to this merchant.`, {
      code: 'COUPON_NOT_FOUND',
      statusCode: 404,
      details: { coupon_code: code },
      recovery: { action: 'Check the coupon code and try again.' },
    });
  }
}

class CouponInactiveError extends ACGError {
  constructor(code, status) {
    super(`Coupon "${code}" is no longer valid (status: ${status}).`, {
      code: 'COUPON_INACTIVE',
      statusCode: 422,
      details: { coupon_code: code, status },
      recovery: { action: 'Use a different coupon or proceed without one.' },
    });
  }
}

class CouponExpiredError extends ACGError {
  constructor(code, validUntil) {
    super(`Coupon "${code}" expired on ${validUntil}.`, {
      code: 'COUPON_EXPIRED',
      statusCode: 422,
      details: { coupon_code: code, valid_until: validUntil },
      recovery: { action: 'Use a coupon that has not expired.' },
    });
  }
}

class CouponNotYetActiveError extends ACGError {
  constructor(code, validFrom) {
    super(`Coupon "${code}" is not yet active (starts: ${validFrom}).`, {
      code: 'COUPON_NOT_YET_ACTIVE',
      statusCode: 422,
      details: { coupon_code: code, valid_from: validFrom },
    });
  }
}

class CouponUsageLimitError extends ACGError {
  constructor(code) {
    super(`Coupon "${code}" has reached its maximum usage limit.`, {
      code: 'COUPON_USAGE_LIMIT_REACHED',
      statusCode: 422,
      details: { coupon_code: code },
      recovery: { action: 'Use a different coupon.' },
    });
  }
}

class CouponCategoryError extends ACGError {
  constructor(code, required, given) {
    super(`Coupon "${code}" is only valid for "${required}" (got "${given}").`, {
      code: 'COUPON_CATEGORY_MISMATCH',
      statusCode: 422,
      details: { coupon_code: code, required_category: required, given_category: given },
    });
  }
}

class CouponMinSpendError extends ACGError {
  constructor(code, minAmount, givenAmount) {
    const minDisplay  = `₹${(minAmount  / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;
    const givenDisplay = `₹${(givenAmount / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;
    super(`Coupon "${code}" requires a minimum order of ${minDisplay} (cart total: ${givenDisplay}).`, {
      code: 'COUPON_MIN_SPEND_NOT_MET',
      statusCode: 422,
      details: { coupon_code: code, min_order_amount: minAmount, cart_amount: givenAmount },
      recovery: { action: `Add items worth at least ${minDisplay} to use this coupon.` },
    });
  }
}

// ─────────────────────────────────────────────────────────────────

class CouponService {
  /**
   * @param {import('better-sqlite3').Database} db
   * @param {import('./audit.service')} [auditService]
   */
  constructor(db, auditService) {
    this.db = db;
    this.auditService = auditService || null;
  }

  // ── Public API ───────────────────────────────────────────────

  /**
   * Validate a coupon code against the given purchase context.
   * Does NOT increment the usage counter (use applyCoupon for that).
   *
   * @param {Object} params
   * @param {string}  params.code          - Coupon code (case-insensitive)
   * @param {string}  params.merchant_id   - Merchant the coupon belongs to
   * @param {number}  params.amount        - Cart total in paise (before discount)
   * @param {string}  [params.category]    - Product category for applicability check
   * @param {string}  [params.audit_trail_id] - For audit logging
   * @returns {Object} Validation result:
   *   { valid: true, coupon, original_amount, discount_amount, discount_display, final_amount, final_display }
   * @throws {CouponNotFoundError | CouponInactiveError | CouponExpiredError | CouponMinSpendError | ...}
   */
  validateCoupon({ code, merchant_id, amount, category, audit_trail_id }) {
    // Lookup — case-insensitive
    const coupon = this.db.prepare(`
      SELECT * FROM coupons
      WHERE merchant_id = ? AND UPPER(code) = UPPER(?)
    `).get(merchant_id, code);

    if (!coupon) {
      throw new CouponNotFoundError(code);
    }

    const now = new Date();

    // Status check
    if (coupon.status !== 'ACTIVE') {
      throw new CouponInactiveError(code, coupon.status);
    }

    // Date range — valid_from
    if (coupon.valid_from && new Date(coupon.valid_from) > now) {
      throw new CouponNotYetActiveError(code, coupon.valid_from);
    }

    // Date range — valid_until
    if (coupon.valid_until && new Date(coupon.valid_until) < now) {
      throw new CouponExpiredError(code, coupon.valid_until);
    }

    // Usage limit
    if (coupon.max_uses !== null && coupon.times_used >= coupon.max_uses) {
      throw new CouponUsageLimitError(code);
    }

    // Category applicability
    if (coupon.applicable_category && category &&
        coupon.applicable_category.toLowerCase() !== category.toLowerCase()) {
      throw new CouponCategoryError(code, coupon.applicable_category, category);
    }

    // Minimum order amount
    if (amount < coupon.min_order_amount) {
      throw new CouponMinSpendError(code, coupon.min_order_amount, amount);
    }

    // ── Calculate discount ────────────────────────────────────
    let discountAmount;

    if (coupon.discount_type === 'FLAT') {
      discountAmount = Math.min(coupon.discount_value, amount);
    } else {
      // PERCENTAGE
      discountAmount = Math.floor(amount * (coupon.discount_value / 100));
      if (coupon.max_discount_amount !== null) {
        discountAmount = Math.min(discountAmount, coupon.max_discount_amount);
      }
    }

    const finalAmount = Math.max(0, amount - discountAmount);

    // Audit: COUPON_PROVIDED + COUPON_VALIDATED (mapped onto DECISION step)
    if (this.auditService && audit_trail_id) {
      this.auditService.logEvent({
        audit_trail_id,
        step: 'DECISION',
        data: {
          action: 'COUPON_VALIDATED',
          coupon_code: code,
          coupon_id: coupon.coupon_id,
          discount_type: coupon.discount_type,
          discount_value: coupon.discount_value,
          original_amount: amount,
          discount_amount: discountAmount,
          final_amount: finalAmount,
        },
      });
    }

    logger.info('[CouponService] Coupon validated', {
      code,
      merchant_id,
      discount_type: coupon.discount_type,
      discount_amount: discountAmount,
      final_amount: finalAmount,
    });

    return {
      valid: true,
      coupon: this._formatCoupon(coupon),
      original_amount:  amount,
      original_display: _paise(amount),
      discount_amount:  discountAmount,
      discount_display: _paise(discountAmount),
      final_amount:     finalAmount,
      final_display:    _paise(finalAmount),
    };
  }

  /**
   * Validate a coupon AND atomically increment its usage counter.
   * Use this when the agent confirms a purchase with a coupon applied.
   *
   * @param {Object} params - Same as validateCoupon
   * @returns {Object} Same shape as validateCoupon result + { applied: true }
   */
  applyCoupon({ code, merchant_id, amount, category, audit_trail_id }) {
    // Validate first (throws on failure)
    const result = this.validateCoupon({ code, merchant_id, amount, category, audit_trail_id });

    // Atomically increment usage count
    const applyTxn = this.db.transaction(() => {
      this.db.prepare(`
        UPDATE coupons SET times_used = times_used + 1
        WHERE coupon_id = ?
      `).run(result.coupon.coupon_id);
    });

    applyTxn();

    // Audit: DISCOUNT_APPLIED
    if (this.auditService && audit_trail_id) {
      this.auditService.logEvent({
        audit_trail_id,
        step: 'DECISION',
        data: {
          action: 'DISCOUNT_APPLIED',
          coupon_code: code,
          coupon_id: result.coupon.coupon_id,
          original_amount: amount,
          discount_amount: result.discount_amount,
          final_amount: result.final_amount,
        },
      });
    }

    logger.info('[CouponService] Coupon applied', {
      code,
      coupon_id: result.coupon.coupon_id,
      final_amount: result.final_amount,
    });

    return { ...result, applied: true };
  }

  /**
   * List available (ACTIVE, not expired) coupons for a merchant.
   * Optionally filter by category and minimum order amount.
   *
   * @param {Object} params
   * @param {string}  params.merchant_id  - Merchant to list coupons for
   * @param {string}  [params.category]   - Filter by category (null = show all)
   * @param {number}  [params.amount]     - Cart total to filter by min_order_amount
   * @returns {Object[]} Array of formatted active coupons
   */
  listCoupons({ merchant_id, category, amount }) {
    const now = new Date().toISOString();

    let query = `
      SELECT * FROM coupons
      WHERE merchant_id = ?
        AND status = 'ACTIVE'
        AND valid_from <= ?
        AND (valid_until IS NULL OR valid_until >= ?)
        AND (max_uses IS NULL OR times_used < max_uses)
    `;
    const params = [merchant_id, now, now];

    if (category) {
      query += ` AND (applicable_category IS NULL OR LOWER(applicable_category) = LOWER(?))`;
      params.push(category);
    }

    if (amount != null) {
      query += ` AND min_order_amount <= ?`;
      params.push(amount);
    }

    query += ` ORDER BY discount_value DESC`;

    const rows = this.db.prepare(query).all(...params);
    return rows.map(r => this._formatCoupon(r));
  }

  // ── Private Helpers ──────────────────────────────────────────

  _formatCoupon(row) {
    return {
      coupon_id:          row.coupon_id,
      merchant_id:        row.merchant_id,
      code:               row.code,
      discount_type:      row.discount_type,
      discount_value:     row.discount_value,
      min_order_amount:   row.min_order_amount,
      max_discount_amount: row.max_discount_amount,
      applicable_category: row.applicable_category || null,
      valid_from:         row.valid_from,
      valid_until:        row.valid_until || null,
      max_uses:           row.max_uses,
      times_used:         row.times_used,
      status:             row.status,
      description:        _buildDescription(row),
    };
  }
}

// ── Module-level helpers ─────────────────────────────────────────

/** Format paise amount as INR display string */
function _paise(paise) {
  return `₹${(paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;
}

/** Build a human-readable coupon description for display */
function _buildDescription(coupon) {
  const type = coupon.discount_type;
  const val  = coupon.discount_value;

  let desc = type === 'FLAT'
    ? `₹${val / 100} off`
    : `${val}% off`;

  if (coupon.max_discount_amount) {
    desc += ` (up to ${_paise(coupon.max_discount_amount)})`;
  }

  if (coupon.applicable_category) {
    desc += ` on ${coupon.applicable_category}`;
  }

  if (coupon.min_order_amount > 0) {
    desc += ` — min order ${_paise(coupon.min_order_amount)}`;
  }

  return desc;
}

// Export service and error classes for use in tests
module.exports = CouponService;
module.exports.CouponNotFoundError   = CouponNotFoundError;
module.exports.CouponExpiredError    = CouponExpiredError;
module.exports.CouponInactiveError   = CouponInactiveError;
module.exports.CouponMinSpendError   = CouponMinSpendError;
module.exports.CouponUsageLimitError = CouponUsageLimitError;
module.exports.CouponCategoryError   = CouponCategoryError;
