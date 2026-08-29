/**
 * @module gateway/services/mandate.service
 * @description Mandate Engine for the Agentic Commerce Gateway.
 * 
 * Implements the AP2-inspired hierarchical mandate chain:
 *   INTENT → CART → PAYMENT
 * 
 * Each mandate is a bounded authorization token that constrains what an
 * AI agent can do. The chain ensures:
 * 
 * 1. INTENT: Human sets spending rules (max amount, categories, merchants)
 * 2. CART: Agent selects products → validated against intent constraints
 * 3. APPROVAL: Human reviews the cart → approves or rejects
 * 4. PAYMENT: System issues a one-time payment authorization token
 * 
 * State Machine:
 *   INTENT:  ACTIVE → USED | EXPIRED | CANCELLED
 *   CART:    PENDING_APPROVAL → APPROVED → USED | REJECTED | EXPIRED
 *   PAYMENT: AUTHORIZED → USED | EXPIRED
 * 
 * @see docs/TRD.md Section 4 — Mandate Token Specification
 * @see docs/PRD.md Section 5 — F2: Bounded Authorization Mandates
 * @see docs/design.md Section 3 — Authorization Model
 */

const { v4: uuidv4 } = require('uuid');
const logger = require('../../lib/logger');
const { createMandateToken, verifyMandateToken } = require('../../lib/jwt');
const {
  MandateExpiredError,
  MandateUsedError,
  AmountExceededError,
  CategoryViolationError,
  MerchantViolationError,
  ApprovalRequiredError,
  ApprovalRejectedError,
  ChainBrokenError,
  InvalidStateTransitionError,
  ProductNotFoundError,
} = require('../../lib/errors');

class MandateService {
  /**
   * @param {import('better-sqlite3').Database} db - The better-sqlite3 database instance
   * @param {import('./audit.service')} [auditService] - Optional AuditService instance
   * @param {import('./coupon.service')} [couponService] - Optional CouponService for discount processing
   */
  constructor(db, auditService, couponService) {
    this.db = db;
    this.auditService = auditService || null;
    this.couponService = couponService || null;
  }

  // ════════════════════════════════════════════════════════════════════
  //  INTENT MANDATE — Human sets spending constraints
  // ════════════════════════════════════════════════════════════════════

  /**
   * Create an Intent Mandate with spending constraints.
   * This is the entry point of the mandate chain — initiated by the human delegator.
   * 
   * @param {Object} params
   * @param {string} params.delegator_id - Human who authorizes the spend
   * @param {string} params.agent_id - AI agent who will shop
   * @param {Object} params.constraints - Spending constraints
   * @param {number} params.constraints.max_amount - Max amount in paise (e.g., 300000 = ₹3,000)
   * @param {string} [params.constraints.currency='INR'] - Currency
   * @param {string[]} [params.constraints.allowed_categories] - e.g., ['footwear']
   * @param {string[]} [params.constraints.allowed_merchants] - e.g., ['merch_sportshub']
   * @param {boolean} [params.constraints.single_use=true] - One-time use (default true)
   * @param {number} [params.ttl=3600] - Time-to-live in seconds
   * @returns {Object} Created mandate with signed JWT token
   */
  createIntentMandate({ delegator_id, agent_id, constraints, ttl = 3600 }) {
    // Validate delegator exists
    const delegator = this.db.prepare('SELECT * FROM delegators WHERE delegator_id = ?').get(delegator_id);
    if (!delegator) {
      throw new ChainBrokenError('new', delegator_id);
    }

    // Validate agent exists
    const agent = this.db.prepare('SELECT * FROM agents WHERE agent_id = ? AND status = ?').get(agent_id, 'ACTIVE');
    if (!agent) {
      throw new ChainBrokenError('new', agent_id);
    }

    const mandateId = `mdt_intent_${uuidv4().split('-')[0]}`;
    const now = new Date();
    const expiresAt = new Date(now.getTime() + ttl * 1000);

    // Normalize constraints
    const normalizedConstraints = {
      max_amount: constraints.max_amount,
      currency: constraints.currency || 'INR',
      allowed_categories: constraints.allowed_categories || [],
      allowed_merchants: constraints.allowed_merchants || [],
      single_use: constraints.single_use !== false, // default true
    };

    // Create signed JWT token
    const token = createMandateToken({
      mandate_id: mandateId,
      mandate_type: 'INTENT',
      delegator_id,
      agent_id,
      constraints: normalizedConstraints,
    }, ttl);

    // Persist to database
    this.db.prepare(`
      INSERT INTO mandates (
        mandate_id, type, status, delegator_id, agent_id,
        constraints, token, created_at, expires_at
      ) VALUES (?, 'INTENT', 'ACTIVE', ?, ?, ?, ?, ?, ?)
    `).run(
      mandateId,
      delegator_id,
      agent_id,
      JSON.stringify(normalizedConstraints),
      token,
      now.toISOString(),
      expiresAt.toISOString()
    );

    if (this.auditService) {
      const maxAmtDisplay = `₹${(normalizedConstraints.max_amount / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;
      const cats = normalizedConstraints.allowed_categories.length > 0
        ? normalizedConstraints.allowed_categories.join(', ')
        : 'any category';
      const descQuery = `Authorize agent ${agent_id} to spend up to ${maxAmtDisplay} on ${cats}`;
      this.auditService.logRequest(mandateId, {
        agent_id,
        delegator_id,
        query: descQuery,
        constraints: normalizedConstraints,
      });
    }

    logger.info('Intent mandate created', {
      mandate_id: mandateId,
      delegator_id,
      agent_id,
      max_amount: normalizedConstraints.max_amount,
      ttl,
    });

    return this._formatMandate(
      this.db.prepare('SELECT * FROM mandates WHERE mandate_id = ?').get(mandateId)
    );
  }

  // ════════════════════════════════════════════════════════════════════
  //  CART MANDATE — Agent selects products, validated against constraints
  // ════════════════════════════════════════════════════════════════════

  /**
   * Create a Cart Mandate by selecting products within intent constraints.
   * Validates each item against the parent intent's spending rules.
   * Supports optional coupon codes — discount is applied BEFORE the spend cap check
   * so a coupon can bring an over-budget cart back within the intent limit.
   *
   * @param {Object} params
   * @param {string} params.intent_mandate_id - Parent intent mandate ID
   * @param {string} params.agent_id - Agent creating the cart
   * @param {Object[]} params.items - Cart items
   * @param {string} params.items[].product_id - Product to add
   * @param {string} [params.items[].variant_id] - Specific variant
   * @param {number} [params.items[].quantity=1] - Quantity
   * @param {string} [params.coupon_code] - Optional coupon/promo code to apply
   * @param {string} [params.merchant_id_for_coupon] - Merchant to validate coupon against
   * @param {Object} [params.reasoning] - Agent's reasoning for selection
   * @returns {Object} Created cart mandate (status: PENDING_APPROVAL)
   */
  createCartMandate({ intent_mandate_id, agent_id, items, reasoning, coupon_code, merchant_id_for_coupon }) {
    // ── Step 1: Validate parent intent mandate ──────────────────────
    const intentMandate = this.db.prepare(
      'SELECT * FROM mandates WHERE mandate_id = ? AND type = ?'
    ).get(intent_mandate_id, 'INTENT');

    if (!intentMandate) {
      throw new ChainBrokenError('new_cart', intent_mandate_id);
    }

    // Verify intent is still active
    this._checkExpiry(intentMandate);
    this._checkUsed(intentMandate);

    if (intentMandate.status !== 'ACTIVE') {
      throw new InvalidStateTransitionError('mandate', intent_mandate_id, intentMandate.status, 'USED');
    }

    // Verify token
    verifyMandateToken(intentMandate.token);

    // Parse constraints
    const constraints = JSON.parse(intentMandate.constraints);

    // ── Step 2: Resolve items and validate constraints ───────────────
    const resolvedItems = [];
    let totalAmount = 0;

    for (const item of items) {
      // Look up product
      const product = this.db.prepare(
        'SELECT * FROM products WHERE product_id = ?'
      ).get(item.product_id);

      if (!product) {
        throw new ProductNotFoundError(item.product_id);
      }

      // Validate category constraint
      if (constraints.allowed_categories && constraints.allowed_categories.length > 0) {
        if (!constraints.allowed_categories.includes(product.category)) {
          if (this.auditService) {
            this.auditService.logMandateCheck(intent_mandate_id, {
              mandate_id: intent_mandate_id,
              mandate_type: 'INTENT',
              constraints,
              check_result: 'FAILED',
              violation: `Category "${product.category}" is not in the allowed list: [${constraints.allowed_categories.join(', ')}]`,
            });
            this.auditService.logOutcome(intent_mandate_id, {
              transaction_id: 'N/A',
              status: 'FAILED',
              total_amount: 0,
              items_count: items.length,
              failure_reason: `Category "${product.category}" not allowed`,
            });
          }
          throw new CategoryViolationError(
            intent_mandate_id, product.category, constraints.allowed_categories
          );
        }
      }

      // Validate merchant constraint
      if (constraints.allowed_merchants && constraints.allowed_merchants.length > 0) {
        if (!constraints.allowed_merchants.includes(product.merchant_id)) {
          if (this.auditService) {
            this.auditService.logMandateCheck(intent_mandate_id, {
              mandate_id: intent_mandate_id,
              mandate_type: 'INTENT',
              constraints,
              check_result: 'FAILED',
              violation: `Merchant "${product.merchant_id}" is not in the allowed list`,
            });
            this.auditService.logOutcome(intent_mandate_id, {
              transaction_id: 'N/A',
              status: 'FAILED',
              total_amount: 0,
              items_count: items.length,
              failure_reason: `Merchant "${product.merchant_id}" not allowed`,
            });
          }
          throw new MerchantViolationError(
            intent_mandate_id, product.merchant_id, constraints.allowed_merchants
          );
        }
      }

      // Resolve variant price
      let unitPrice = product.price_amount;
      if (item.variant_id) {
        const variant = this.db.prepare(
          'SELECT * FROM variants WHERE variant_id = ? AND product_id = ?'
        ).get(item.variant_id, item.product_id);

        if (variant && variant.price_override) {
          unitPrice = variant.price_override;
        }
      }

      const qty = item.quantity || 1;
      const lineTotal = unitPrice * qty;
      totalAmount += lineTotal;

      resolvedItems.push({
        product_id: item.product_id,
        variant_id: item.variant_id || null,
        quantity: qty,
        unit_price: unitPrice,
        line_total: lineTotal,
        product_name: product.name,
      });
    }

    // ── Step 3: Apply coupon (if provided) & compute final amount ────
    let originalAmount = totalAmount;
    let discountAmount = 0;
    let finalAmount    = totalAmount;
    let appliedCoupon  = null;

    if (coupon_code && this.couponService) {
      try {
        // Determine the merchant to validate against: from first item or caller-provided
        const merchantId = merchant_id_for_coupon ||
          (resolvedItems[0]
            ? this.db.prepare('SELECT merchant_id FROM products WHERE product_id = ?')
                .get(resolvedItems[0].product_id)?.merchant_id
            : null);

        // Determine primary category from first item
        const firstProduct = resolvedItems[0]
          ? this.db.prepare('SELECT category FROM products WHERE product_id = ?')
              .get(resolvedItems[0].product_id)
          : null;
        const category = firstProduct?.category || null;

        // Audit: COUPON_PROVIDED (pre-validation signal)
        if (this.auditService) {
          this.auditService.logEvent({
            audit_trail_id: intent_mandate_id,
            step: 'DECISION',
            data: {
              action: 'COUPON_PROVIDED',
              coupon_code,
              cart_total: totalAmount,
            },
          });
        }

        const couponResult = this.couponService.validateCoupon({
          code:            coupon_code,
          merchant_id:     merchantId,
          amount:          totalAmount,
          category,
          audit_trail_id:  intent_mandate_id,
        });

        discountAmount = couponResult.discount_amount;
        finalAmount    = couponResult.final_amount;
        appliedCoupon  = couponResult.coupon;

        logger.info('Coupon applied to cart mandate', {
          coupon_code,
          original_amount: originalAmount,
          discount_amount:  discountAmount,
          final_amount:     finalAmount,
        });
      } catch (couponErr) {
        // Coupon validation failure is non-fatal: log it and proceed without discount
        logger.warn(`Coupon validation failed for "${coupon_code}": ${couponErr.message}`);
        if (this.auditService) {
          this.auditService.logError(intent_mandate_id, {
            step_context: 'coupon_validation',
            error_code:   couponErr.code || 'COUPON_ERROR',
            error_message: couponErr.message,
          });
        }
      }
    }

    // ── Step 4: Validate FINAL amount against spend cap ───────────────
    // Important: use finalAmount (after coupon discount) so the coupon
    // can bring an over-budget cart back within the spend limit.
    const amountToCheck = finalAmount;
    if (amountToCheck > constraints.max_amount) {
      if (this.auditService) {
        this.auditService.logMandateCheck(intent_mandate_id, {
          mandate_id: intent_mandate_id,
          mandate_type: 'INTENT',
          constraints,
          check_result: 'FAILED',
          violation: `Final amount ${amountToCheck} exceeds max_amount ${constraints.max_amount}${
            discountAmount > 0 ? ` (original: ${originalAmount}, discount: ${discountAmount})` : ''
          }`,
        });
        this.auditService.logOutcome(intent_mandate_id, {
          transaction_id: 'N/A',
          status: 'FAILED',
          total_amount: amountToCheck,
          items_count: items.length,
          failure_reason: `Spend cap exceeded: final ${amountToCheck} > cap ${constraints.max_amount}`,
        });
      }
      throw new AmountExceededError(
        intent_mandate_id,
        constraints.max_amount,
        amountToCheck,
        constraints.currency
      );
    }

    // Log decision and successful mandate check
    if (this.auditService) {
      this.auditService.logDecision(intent_mandate_id, {
        agent_id,
        selected_product: resolvedItems.map(i => `${i.product_name} (x${i.quantity})`).join(', '),
        reason: reasoning?.reason || 'Selected optimal product matching requirements',
        alternatives: reasoning?.alternatives || [],
        score: 1.0,
      });

      this.auditService.logMandateCheck(intent_mandate_id, {
        mandate_id: intent_mandate_id,
        mandate_type: 'INTENT',
        constraints,
        check_result: 'PASSED',
      });
    }

    // ── Step 5: Create cart mandate ──────────────────────────────────
    const mandateId = `mdt_cart_${uuidv4().split('-')[0]}`;
    const now = new Date();
    // Cart mandate inherits remaining TTL from intent, max 30 minutes for approval
    const intentExpiry = new Date(intentMandate.expires_at);
    const maxApprovalWindow = new Date(now.getTime() + 30 * 60 * 1000);
    const expiresAt = intentExpiry < maxApprovalWindow ? intentExpiry : maxApprovalWindow;
    const ttl = Math.floor((expiresAt.getTime() - now.getTime()) / 1000);

    const token = createMandateToken({
      mandate_id: mandateId,
      mandate_type: 'CART',
      delegator_id: intentMandate.delegator_id,
      agent_id,
      constraints,
      parent_mandate_id: intent_mandate_id,
      cart: { items: resolvedItems, total_amount: totalAmount },
    }, ttl);

    this.db.prepare(`
      INSERT INTO mandates (
        mandate_id, type, status, parent_mandate_id, delegator_id, agent_id,
        merchant_id, constraints, items, reasoning, token,
        coupon_code, original_amount, discount_amount, final_amount,
        created_at, expires_at
      ) VALUES (?, 'CART', 'PENDING_APPROVAL', ?, ?, ?, ?, ?, ?, ?, ?,
                ?, ?, ?, ?, ?, ?)
    `).run(
      mandateId,
      intent_mandate_id,
      intentMandate.delegator_id,
      agent_id,
      resolvedItems[0] ? this.db.prepare('SELECT merchant_id FROM products WHERE product_id = ?').get(resolvedItems[0].product_id)?.merchant_id : null,
      JSON.stringify(constraints),
      JSON.stringify(resolvedItems),
      reasoning ? JSON.stringify(reasoning) : null,
      token,
      appliedCoupon ? coupon_code : null,
      originalAmount,
      discountAmount,
      finalAmount,
      now.toISOString(),
      expiresAt.toISOString()
    );

    logger.info('Cart mandate created', {
      mandate_id: mandateId,
      parent: intent_mandate_id,
      original_amount: originalAmount,
      discount_amount: discountAmount,
      final_amount: finalAmount,
      coupon_code: appliedCoupon ? coupon_code : null,
      item_count: resolvedItems.length,
      status: 'PENDING_APPROVAL',
    });

    return this._formatMandate(
      this.db.prepare('SELECT * FROM mandates WHERE mandate_id = ?').get(mandateId)
    );
  }

  // ════════════════════════════════════════════════════════════════════
  //  EXPLICIT PURCHASE CONFIRMATION GATE
  // ════════════════════════════════════════════════════════════════════

  /**
   * Record explicit user purchase confirmation on a cart mandate.
   * This must be called BEFORE payment execution is allowed.
   *
   * @param {Object} params
   * @param {string} params.cart_mandate_id - Cart mandate to confirm
   * @param {boolean} params.user_confirmation - true = confirm, false = reject
   * @param {string} params.channel - Confirmation channel (VOICE, TEXT, API)
   * @param {string} [params.confirmation_phrase] - Exact phrase the user spoke/typed
   * @returns {Object} { mandate_id, confirmation_status, confirmed_at, ready_for_payment }
   */
  confirmCartMandate({ cart_mandate_id, user_confirmation, channel, confirmation_phrase }) {
    const cartMandate = this.db.prepare(
      'SELECT * FROM mandates WHERE mandate_id = ? AND type = ?'
    ).get(cart_mandate_id, 'CART');

    if (!cartMandate) {
      throw new ChainBrokenError(cart_mandate_id, 'not_found');
    }

    // Only allow confirmation on PENDING_APPROVAL or APPROVED carts
    if (!['PENDING_APPROVAL', 'APPROVED'].includes(cartMandate.status)) {
      throw new InvalidStateTransitionError(
        'mandate', cart_mandate_id, cartMandate.status,
        user_confirmation ? 'EXPLICIT_CONFIRMED' : 'REJECTED'
      );
    }

    const now = new Date().toISOString();

    if (user_confirmation) {
      // ── EXPLICIT CONFIRMED ─────────────────────────────────────────
      this.db.prepare(`
        UPDATE mandates
        SET confirmation_status  = 'EXPLICIT_CONFIRMED',
            confirmed_at         = ?,
            confirmation_channel = ?,
            confirmation_phrase  = ?
        WHERE mandate_id = ?
      `).run(now, channel, confirmation_phrase || null, cart_mandate_id);

      if (this.auditService) {
        this.auditService.logEvent({
          audit_trail_id: cartMandate.parent_mandate_id,
          step: 'APPROVAL',
          data: {
            action: 'CONFIRMATION_RECORDED',
            cart_mandate_id,
            channel,
            confirmation_phrase: confirmation_phrase || null,
            confirmed_at: now,
          },
        });
      }

      logger.info('Explicit purchase confirmation recorded', {
        cart_mandate_id,
        channel,
        confirmation_status: 'EXPLICIT_CONFIRMED',
      });

      return {
        mandate_id: cart_mandate_id,
        confirmation_status: 'EXPLICIT_CONFIRMED',
        confirmed_at: now,
        ready_for_payment: true,
      };
    } else {
      // ── REJECTED ──────────────────────────────────────────────────
      this.db.prepare(`
        UPDATE mandates
        SET confirmation_status  = 'REJECTED',
            confirmed_at         = ?,
            confirmation_channel = ?,
            confirmation_phrase  = ?
        WHERE mandate_id = ?
      `).run(now, channel, confirmation_phrase || null, cart_mandate_id);

      if (this.auditService) {
        this.auditService.logEvent({
          audit_trail_id: cartMandate.parent_mandate_id,
          step: 'APPROVAL',
          data: {
            action: 'CONFIRMATION_REJECTED',
            cart_mandate_id,
            channel,
            confirmation_phrase: confirmation_phrase || null,
            confirmed_at: now,
          },
        });
      }

      logger.info('Purchase confirmation rejected by user', {
        cart_mandate_id,
        channel,
        confirmation_status: 'REJECTED',
      });

      return {
        mandate_id: cart_mandate_id,
        confirmation_status: 'REJECTED',
        confirmed_at: now,
        ready_for_payment: false,
      };
    }
  }

  // ════════════════════════════════════════════════════════════════════
  //  APPROVAL FLOW — Human approves or rejects the cart
  // ════════════════════════════════════════════════════════════════════

  /**
   * Approve a cart mandate — transitions to APPROVED and creates a Payment Mandate.
   * 
   * @param {string} cartMandateId - Cart mandate ID to approve
   * @param {string} approvedBy - ID of the approver (delegator)
   * @returns {Object} The generated Payment Mandate with one-time-use token
   */
  approveCartMandate(cartMandateId, approvedBy) {
    const cartMandate = this.db.prepare(
      'SELECT * FROM mandates WHERE mandate_id = ? AND type = ?'
    ).get(cartMandateId, 'CART');

    if (!cartMandate) {
      throw new ChainBrokenError(cartMandateId, 'not_found');
    }

    this._checkExpiry(cartMandate);

    if (cartMandate.status !== 'PENDING_APPROVAL') {
      throw new InvalidStateTransitionError('mandate', cartMandateId, cartMandate.status, 'APPROVED');
    }

    const now = new Date();

    // ── Transition cart to APPROVED ──────────────────────────────────
    this.db.prepare(`
      UPDATE mandates SET status = 'APPROVED', approved_at = ?, approved_by = ?
      WHERE mandate_id = ?
    `).run(now.toISOString(), approvedBy, cartMandateId);

    // ── Mark parent intent as USED (single-use) ─────────────────────
    const constraints = JSON.parse(cartMandate.constraints);
    if (constraints.single_use) {
      this.db.prepare(`
        UPDATE mandates SET status = 'USED', used_at = ?
        WHERE mandate_id = ?
      `).run(now.toISOString(), cartMandate.parent_mandate_id);
    }

    // ── Create Payment Mandate (one-time-use, short TTL) ────────────
    const paymentMandateId = `mdt_pay_${uuidv4().split('-')[0]}`;
    const paymentTtl = 600; // 10 minutes to complete payment
    const paymentExpiresAt = new Date(now.getTime() + paymentTtl * 1000);

    const items = JSON.parse(cartMandate.items);
    const totalAmount = items.reduce((sum, i) => sum + i.line_total, 0);

    const paymentToken = createMandateToken({
      mandate_id: paymentMandateId,
      mandate_type: 'PAYMENT',
      delegator_id: cartMandate.delegator_id,
      agent_id: cartMandate.agent_id,
      constraints: {
        ...constraints,
        single_use: true, // Payment mandates are always single-use
        exact_amount: totalAmount, // Lock to exact cart total
      },
      parent_mandate_id: cartMandateId,
      cart: { items, total_amount: totalAmount },
    }, paymentTtl);

    this.db.prepare(`
      INSERT INTO mandates (
        mandate_id, type, status, parent_mandate_id, delegator_id, agent_id,
        merchant_id, constraints, items, token, created_at, expires_at
      ) VALUES (?, 'PAYMENT', 'AUTHORIZED', ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      paymentMandateId,
      cartMandateId,
      cartMandate.delegator_id,
      cartMandate.agent_id,
      cartMandate.merchant_id,
      JSON.stringify({ ...constraints, single_use: true, exact_amount: totalAmount }),
      cartMandate.items,
      paymentToken,
      now.toISOString(),
      paymentExpiresAt.toISOString()
    );

    if (this.auditService) {
      this.auditService.logApproval(cartMandate.parent_mandate_id, {
        cart_mandate_id: cartMandateId,
        delegator_id: approvedBy,
        decision: 'APPROVED',
        payment_mandate_id: paymentMandateId,
      });
    }

    logger.info('Cart approved → Payment mandate created', {
      cart_mandate_id: cartMandateId,
      payment_mandate_id: paymentMandateId,
      approved_by: approvedBy,
      total_amount: totalAmount,
    });

    return this._formatMandate(
      this.db.prepare('SELECT * FROM mandates WHERE mandate_id = ?').get(paymentMandateId)
    );
  }

  /**
   * Reject a cart mandate — the human declines the agent's selection.
   * 
   * @param {string} cartMandateId - Cart mandate ID to reject
   * @param {string} rejectedBy - ID of the rejector (delegator)
   * @param {string} [reason] - Reason for rejection
   * @returns {Object} Updated cart mandate with REJECTED status
   */
  rejectCartMandate(cartMandateId, rejectedBy, reason = '') {
    const cartMandate = this.db.prepare(
      'SELECT * FROM mandates WHERE mandate_id = ? AND type = ?'
    ).get(cartMandateId, 'CART');

    if (!cartMandate) {
      throw new ChainBrokenError(cartMandateId, 'not_found');
    }

    if (cartMandate.status !== 'PENDING_APPROVAL') {
      throw new InvalidStateTransitionError('mandate', cartMandateId, cartMandate.status, 'REJECTED');
    }

    const now = new Date();

    this.db.prepare(`
      UPDATE mandates SET status = 'REJECTED', rejected_at = ?, rejected_by = ?, rejection_reason = ?
      WHERE mandate_id = ?
    `).run(now.toISOString(), rejectedBy, reason, cartMandateId);

    if (this.auditService) {
      this.auditService.logApproval(cartMandate.parent_mandate_id, {
        cart_mandate_id: cartMandateId,
        delegator_id: rejectedBy,
        decision: 'REJECTED',
        reason,
      });
      this.auditService.logOutcome(cartMandate.parent_mandate_id, {
        transaction_id: 'N/A',
        status: 'REJECTED',
        total_amount: 0,
        items_count: 0,
        failure_reason: `Rejected by delegator: ${reason}`,
      });
    }

    logger.info('Cart mandate rejected', {
      cart_mandate_id: cartMandateId,
      rejected_by: rejectedBy,
      reason,
    });

    return this._formatMandate(
      this.db.prepare('SELECT * FROM mandates WHERE mandate_id = ?').get(cartMandateId)
    );
  }

  // ════════════════════════════════════════════════════════════════════
  //  QUERY METHODS
  // ════════════════════════════════════════════════════════════════════

  /**
   * Get a mandate by ID with full chain info.
   * @param {string} mandateId
   * @returns {Object} Formatted mandate
   */
  getMandateById(mandateId) {
    const mandate = this.db.prepare('SELECT * FROM mandates WHERE mandate_id = ?').get(mandateId);
    if (!mandate) {
      throw new ChainBrokenError(mandateId, 'not_found');
    }
    return this._formatMandate(mandate);
  }

  /**
   * Get the full mandate chain for a given mandate.
   * Walks up the parent_mandate_id chain to reconstruct INTENT → CART → PAYMENT.
   * 
   * @param {string} mandateId - Any mandate in the chain
   * @returns {Object} Chain object with intent, cart, and payment mandates
   */
  getMandateChain(mandateId) {
    const chain = [];
    let current = this.db.prepare('SELECT * FROM mandates WHERE mandate_id = ?').get(mandateId);

    while (current) {
      chain.unshift(this._formatMandate(current));
      if (current.parent_mandate_id) {
        current = this.db.prepare('SELECT * FROM mandates WHERE mandate_id = ?').get(current.parent_mandate_id);
      } else {
        current = null;
      }
    }

    // Also walk down to find children
    let lastId = mandateId;
    let child = this.db.prepare('SELECT * FROM mandates WHERE parent_mandate_id = ?').get(lastId);
    while (child) {
      chain.push(this._formatMandate(child));
      lastId = child.mandate_id;
      child = this.db.prepare('SELECT * FROM mandates WHERE parent_mandate_id = ?').get(lastId);
    }

    // Deduplicate by mandate_id
    const seen = new Set();
    const deduped = chain.filter((m) => {
      if (seen.has(m.mandate_id)) return false;
      seen.add(m.mandate_id);
      return true;
    });

    return {
      chain: deduped,
      intent: deduped.find((m) => m.type === 'INTENT') || null,
      cart: deduped.find((m) => m.type === 'CART') || null,
      payment: deduped.find((m) => m.type === 'PAYMENT') || null,
    };
  }

  // ════════════════════════════════════════════════════════════════════
  //  PRIVATE HELPERS
  // ════════════════════════════════════════════════════════════════════

  /**
   * Check if a mandate has expired. Throws MandateExpiredError if so.
   * @param {Object} mandate - Raw mandate row
   * @private
   */
  _checkExpiry(mandate) {
    const now = new Date();
    const expiresAt = new Date(mandate.expires_at);
    if (now > expiresAt) {
      // Update status in DB
      this.db.prepare("UPDATE mandates SET status = 'EXPIRED' WHERE mandate_id = ?").run(mandate.mandate_id);
      throw new MandateExpiredError(mandate.mandate_id);
    }
  }

  /**
   * Check if a single-use mandate has been used. Throws MandateUsedError if so.
   * @param {Object} mandate - Raw mandate row
   * @private
   */
  _checkUsed(mandate) {
    if (mandate.status === 'USED') {
      throw new MandateUsedError(mandate.mandate_id);
    }
  }

  /**
   * Format a raw mandate row for API response.
   * @param {Object} row - Raw SQLite row
   * @returns {Object} Formatted mandate
   * @private
   */
  _formatMandate(row) {
    const constraints = this._safeJSON(row.constraints, {});
    const items = this._safeJSON(row.items, null);
    const reasoning = this._safeJSON(row.reasoning, null);

    // Compute total from items
    let totalAmount = null;
    if (items) {
      totalAmount = items.reduce((sum, i) => sum + (i.line_total || i.unit_price * i.quantity), 0);
    }

    return {
      mandate_id: row.mandate_id,
      type: row.type,
      status: row.status,
      parent_mandate_id: row.parent_mandate_id || null,
      delegator_id: row.delegator_id,
      agent_id: row.agent_id,
      merchant_id: row.merchant_id || null,
      constraints: {
        max_amount: constraints.max_amount,
        currency: constraints.currency || 'INR',
        allowed_categories: constraints.allowed_categories || [],
        allowed_merchants: constraints.allowed_merchants || [],
        single_use: constraints.single_use !== false,
        ...(constraints.exact_amount && { exact_amount: constraints.exact_amount }),
      },
      ...(items && {
        cart: {
          items,
          total_amount: totalAmount,
          total_display: `₹${(totalAmount / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`,
        },
      }),
      // Coupon & discount fields (v2)
      ...(row.coupon_code != null && {
        coupon: {
          code:             row.coupon_code,
          original_amount:  row.original_amount  ?? totalAmount,
          discount_amount:  row.discount_amount  ?? 0,
          final_amount:     row.final_amount      ?? totalAmount,
          original_display: _fmtPaise(row.original_amount  ?? totalAmount),
          discount_display: _fmtPaise(row.discount_amount  ?? 0),
          final_display:    _fmtPaise(row.final_amount     ?? totalAmount),
        },
      }),
      ...(reasoning && { reasoning }),
      token: row.token,
      created_at: row.created_at,
      expires_at: row.expires_at,
      ...(row.approved_at && { approved_at: row.approved_at, approved_by: row.approved_by }),
      ...(row.rejected_at && { rejected_at: row.rejected_at, rejected_by: row.rejected_by, rejection_reason: row.rejection_reason }),
      ...(row.used_at && { used_at: row.used_at }),
      // Confirmation gate fields (Phase 13)
      confirmation_status: row.confirmation_status || 'PENDING',
      ...(row.confirmed_at && { confirmed_at: row.confirmed_at }),
      ...(row.confirmation_channel && { confirmation_channel: row.confirmation_channel }),
      ...(row.confirmation_phrase && { confirmation_phrase: row.confirmation_phrase }),
    };
  }

  /**
   * Safely parse JSON, returning fallback on failure.
   * @private
   */
  _safeJSON(str, fallback) {
    if (!str) return fallback;
    try { return JSON.parse(str); } catch { return fallback; }
  }
}

/** Format paise as INR display string @private */
function _fmtPaise(paise) {
  if (paise == null) return null;
  return `₹${(paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;
}

module.exports = MandateService;
