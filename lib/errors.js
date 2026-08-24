/**
 * @module lib/errors
 * @description Custom error classes for the Agentic Commerce Gateway.
 * 
 * Every error has:
 * - A machine-readable `code` (error enum for agents to switch on)
 * - An HTTP `statusCode`
 * - A human-readable `message`
 * - Optional `details` object with context
 * - Optional `recovery` object telling the agent what to do next
 * 
 * @see docs/design.md Section 2.5 — Structured Errors as a First-Class API
 * @see docs/TRD.md Section 7 — Error Taxonomy
 */

/**
 * Base error class for all ACG application errors.
 * Extends native Error with structured fields for API responses.
 */
class ACGError extends Error {
  /**
   * @param {string} message - Human-readable error message
   * @param {Object} options
   * @param {string} options.code - Machine-readable error code (e.g. 'AMOUNT_EXCEEDED')
   * @param {number} options.statusCode - HTTP status code
   * @param {Object} [options.details] - Additional context for debugging
   * @param {Object} [options.recovery] - Suggested recovery action for the agent
   */
  constructor(message, { code, statusCode = 500, details = null, recovery = null } = {}) {
    super(message);
    this.name = this.constructor.name;
    this.code = code || 'INTERNAL_ERROR';
    this.statusCode = statusCode;
    this.details = details;
    this.recovery = recovery;
  }

  /**
   * Serialize this error to a structured API response body.
   * @param {string} [traceId] - Request trace ID for audit correlation
   * @returns {Object} Structured error response
   */
  toJSON(traceId) {
    return {
      error: this.code,
      code: this.statusCode,
      message: this.message,
      ...(this.details && { details: this.details }),
      ...(this.recovery && { recovery: this.recovery }),
      timestamp: new Date().toISOString(),
      ...(traceId && { trace_id: traceId }),
    };
  }
}

// ── Mandate Errors ──────────────────────────────────────────────────

/** Mandate TTL has expired */
class MandateExpiredError extends ACGError {
  constructor(mandateId) {
    super(`Mandate ${mandateId} has expired`, {
      code: 'MANDATE_EXPIRED',
      statusCode: 403,
      details: { mandate_id: mandateId },
      recovery: { action: 'CREATE_NEW_MANDATE', suggestion: 'Create a new mandate with the delegator' },
    });
  }
}

/** Single-use mandate already consumed */
class MandateUsedError extends ACGError {
  constructor(mandateId) {
    super(`Mandate ${mandateId} has already been used`, {
      code: 'MANDATE_USED',
      statusCode: 403,
      details: { mandate_id: mandateId },
      recovery: { action: 'CREATE_NEW_MANDATE', suggestion: 'Request a new mandate from the delegator' },
    });
  }
}

/** Requested amount exceeds mandate cap */
class AmountExceededError extends ACGError {
  constructor(mandateId, limit, actual, currency = 'INR') {
    const limitDisplay = `₹${(limit / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;
    const actualDisplay = `₹${(actual / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;
    super(`Requested amount ${actualDisplay} exceeds mandate cap of ${limitDisplay}`, {
      code: 'AMOUNT_EXCEEDED',
      statusCode: 402,
      details: { mandate_id: mandateId, constraint: 'max_amount', limit, actual, currency },
      recovery: { action: 'SEARCH_ALTERNATIVES', suggestion: `Search for products under the mandate cap of ${limitDisplay}` },
    });
  }
}

/** Product category not in allowed list */
class CategoryViolationError extends ACGError {
  constructor(mandateId, category, allowedCategories) {
    super(`Category "${category}" is not in the allowed list: [${allowedCategories.join(', ')}]`, {
      code: 'CATEGORY_VIOLATION',
      statusCode: 402,
      details: { mandate_id: mandateId, constraint: 'allowed_categories', category, allowed: allowedCategories },
      recovery: { action: 'SEARCH_ALTERNATIVES', suggestion: `Search within allowed categories: ${allowedCategories.join(', ')}` },
    });
  }
}

/** Merchant not in allowed list */
class MerchantViolationError extends ACGError {
  constructor(mandateId, merchantId, allowedMerchants) {
    super(`Merchant "${merchantId}" is not in the allowed list`, {
      code: 'MERCHANT_VIOLATION',
      statusCode: 402,
      details: { mandate_id: mandateId, constraint: 'allowed_merchants', merchant_id: merchantId, allowed: allowedMerchants },
      recovery: { action: 'SEARCH_ALTERNATIVES', suggestion: `Only purchase from allowed merchants: ${allowedMerchants.join(', ')}` },
    });
  }
}

/** Cart mandate not yet approved by human */
class ApprovalRequiredError extends ACGError {
  constructor(mandateId) {
    super(`Cart mandate ${mandateId} has not been approved yet`, {
      code: 'APPROVAL_REQUIRED',
      statusCode: 403,
      details: { mandate_id: mandateId },
      recovery: { action: 'WAIT_FOR_APPROVAL', suggestion: 'Wait for the human delegator to approve the cart' },
    });
  }
}

/** Human rejected the cart */
class ApprovalRejectedError extends ACGError {
  constructor(mandateId, reason) {
    super(`Cart mandate ${mandateId} was rejected by the delegator`, {
      code: 'APPROVAL_REJECTED',
      statusCode: 403,
      details: { mandate_id: mandateId, rejection_reason: reason },
      recovery: { action: 'REVISE_CART', suggestion: 'Modify the cart based on the rejection reason and resubmit' },
    });
  }
}

/** Parent mandate reference invalid — chain is broken */
class ChainBrokenError extends ACGError {
  constructor(mandateId, parentMandateId) {
    super(`Mandate chain is broken: parent mandate ${parentMandateId} is invalid or not found`, {
      code: 'CHAIN_BROKEN',
      statusCode: 400,
      details: { mandate_id: mandateId, parent_mandate_id: parentMandateId },
      recovery: { action: 'RESTART_FLOW', suggestion: 'Create a new intent mandate and start the flow over' },
    });
  }
}

/** Invalid state transition attempted */
class InvalidStateTransitionError extends ACGError {
  constructor(entityType, entityId, fromStatus, toStatus) {
    super(`Cannot transition ${entityType} ${entityId} from ${fromStatus} to ${toStatus}`, {
      code: 'INVALID_STATE_TRANSITION',
      statusCode: 409,
      details: { entity_type: entityType, entity_id: entityId, from_status: fromStatus, to_status: toStatus },
    });
  }
}

// ── Catalog Errors ──────────────────────────────────────────────────

/** Product not found */
class ProductNotFoundError extends ACGError {
  constructor(productId) {
    super(`Product ${productId} does not exist`, {
      code: 'PRODUCT_NOT_FOUND',
      statusCode: 404,
      details: { product_id: productId },
      recovery: { action: 'SEARCH_CATALOG', suggestion: 'Search the catalog for available products' },
    });
  }
}

/** Product is out of stock */
class OutOfStockError extends ACGError {
  constructor(productId, variantId = null) {
    super(`Product ${productId}${variantId ? ` (variant ${variantId})` : ''} is out of stock`, {
      code: 'OUT_OF_STOCK',
      statusCode: 409,
      details: { product_id: productId, ...(variantId && { variant_id: variantId }) },
      recovery: { action: 'SEARCH_ALTERNATIVES', suggestion: 'Search for alternative products that are in stock' },
    });
  }
}

/** Stock changed between discovery and checkout */
class StockChangedError extends ACGError {
  constructor(productId, expectedQty, actualQty) {
    super(`Stock for product ${productId} changed: expected ${expectedQty}, now ${actualQty}`, {
      code: 'STOCK_CHANGED',
      statusCode: 409,
      details: { product_id: productId, expected_quantity: expectedQty, actual_quantity: actualQty },
      recovery: { action: 'REFRESH_CART', suggestion: 'Re-query the catalog and update the cart with current stock' },
    });
  }
}

/** Price changed between discovery and checkout */
class PriceChangedError extends ACGError {
  constructor(productId, expectedPrice, actualPrice) {
    super(`Price for product ${productId} changed: expected ${expectedPrice}, now ${actualPrice}`, {
      code: 'PRICE_CHANGED',
      statusCode: 409,
      details: { product_id: productId, expected_price: expectedPrice, actual_price: actualPrice },
      recovery: { action: 'REFRESH_CART', suggestion: 'Re-query the catalog and update the cart with current pricing' },
    });
  }
}

// ── Payment Errors ──────────────────────────────────────────────────

/** Razorpay payment declined or failed */
class PaymentFailedError extends ACGError {
  constructor(reason, razorpayOrderId = null) {
    super(`Payment failed: ${reason}`, {
      code: 'PAYMENT_FAILED',
      statusCode: 502,
      details: { reason, ...(razorpayOrderId && { razorpay_order_id: razorpayOrderId }) },
      recovery: { action: 'RETRY_PAYMENT', suggestion: 'Retry the payment or use an alternative payment method' },
    });
  }
}

/** Razorpay API timeout */
class PaymentTimeoutError extends ACGError {
  constructor(razorpayOrderId = null) {
    super('Payment processing timed out', {
      code: 'PAYMENT_TIMEOUT',
      statusCode: 504,
      details: { ...(razorpayOrderId && { razorpay_order_id: razorpayOrderId }) },
      recovery: { action: 'RETRY_PAYMENT', suggestion: 'Retry the payment — the mandate is still valid' },
    });
  }
}

// ── Auth Errors ─────────────────────────────────────────────────────

/** JWT token invalid or malformed */
class InvalidTokenError extends ACGError {
  constructor(reason = 'Token is invalid or malformed') {
    super(reason, {
      code: 'INVALID_TOKEN',
      statusCode: 401,
      recovery: { action: 'AUTHENTICATE', suggestion: 'Provide a valid API key or mandate token' },
    });
  }
}

// ── Validation Errors ───────────────────────────────────────────────

/** Request body/query failed Zod schema validation */
class ValidationError extends ACGError {
  constructor(errors) {
    super('Request validation failed', {
      code: 'VALIDATION_ERROR',
      statusCode: 400,
      details: { validation_errors: errors },
      recovery: { action: 'FIX_REQUEST', suggestion: 'Check the request against the API schema and correct the errors' },
    });
  }
}

module.exports = {
  ACGError,
  // Mandate errors
  MandateExpiredError,
  MandateUsedError,
  AmountExceededError,
  CategoryViolationError,
  MerchantViolationError,
  ApprovalRequiredError,
  ApprovalRejectedError,
  ChainBrokenError,
  InvalidStateTransitionError,
  // Catalog errors
  ProductNotFoundError,
  OutOfStockError,
  StockChangedError,
  PriceChangedError,
  // Payment errors
  PaymentFailedError,
  PaymentTimeoutError,
  // Auth errors
  InvalidTokenError,
  // Validation errors
  ValidationError,
};
