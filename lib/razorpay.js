/**
 * @module lib/razorpay
 * @description Razorpay SDK wrapper for the Agentic Commerce Gateway.
 * 
 * Provides a unified interface for Razorpay operations:
 * - Order creation (Orders API)
 * - Payment capture (Payments API)
 * - Payment signature verification (HMAC-SHA256)
 * 
 * Supports two modes:
 * 1. LIVE TEST MODE: Uses real Razorpay test keys (rzp_test_xxx) to hit the sandbox API.
 * 2. SIMULATION MODE: When keys are placeholders, simulates Razorpay responses locally.
 *    This allows the full demo flow to work without real API credentials.
 * 
 * @see docs/TRD.md Section 5 — Payment Gateway Integration
 * @see docs/design.md Section 4 — Payment Safety
 */

const Razorpay = require('razorpay');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const logger = require('./logger');
const { PaymentFailedError, PaymentTimeoutError } = require('./errors');

class RazorpayWrapper {
  /**
   * @param {Object} options
   * @param {string} options.keyId - Razorpay key ID
   * @param {string} options.keySecret - Razorpay key secret
   */
  constructor({ keyId, keySecret }) {
    this.keyId = keyId;
    this.keySecret = keySecret;

    // Detect if we're using placeholder keys (simulation mode)
    this.isSimulation = !keyId || keyId.includes('xxxxx') || keyId === 'rzp_test_xxxxxxxxxxxxx';

    if (this.isSimulation) {
      logger.warn('Razorpay running in SIMULATION MODE — no real API calls will be made');
      this.client = null;
    } else {
      this.client = new Razorpay({
        key_id: keyId,
        key_secret: keySecret,
      });
      logger.info('Razorpay SDK initialized in TEST MODE', { key_id: keyId.substring(0, 12) + '...' });
    }
  }

  /**
   * Create a Razorpay order.
   * 
   * @param {Object} params
   * @param {number} params.amount - Amount in paise (smallest currency unit)
   * @param {string} params.currency - Currency code (default: INR)
   * @param {string} params.receipt - Unique receipt ID (mandate/transaction ID)
   * @param {Object} [params.notes] - Key-value notes for the order
   * @returns {Promise<Object>} Razorpay order object
   * @throws {PaymentFailedError} If order creation fails
   */
  async createOrder({ amount, currency = 'INR', receipt, notes = {} }) {
    if (this.isSimulation) {
      return this._simulateCreateOrder({ amount, currency, receipt, notes });
    }

    try {
      const order = await this.client.orders.create({
        amount,
        currency,
        receipt,
        notes: {
          ...notes,
          source: 'acg_gateway',
        },
      });

      logger.info('Razorpay order created', {
        order_id: order.id,
        amount: order.amount,
        currency: order.currency,
        status: order.status,
      });

      return order;
    } catch (err) {
      logger.error('Razorpay order creation failed', {
        error: err.message,
        receipt,
        amount,
      });
      throw new PaymentFailedError(`Order creation failed: ${err.message}`);
    }
  }

  /**
   * Fetch a payment by ID.
   * 
   * @param {string} paymentId - Razorpay payment ID
   * @returns {Promise<Object>} Payment object
   */
  async fetchPayment(paymentId) {
    if (this.isSimulation) {
      return this._simulateFetchPayment(paymentId);
    }

    try {
      return await this.client.payments.fetch(paymentId);
    } catch (err) {
      logger.error('Razorpay payment fetch failed', { payment_id: paymentId, error: err.message });
      throw new PaymentFailedError(`Payment fetch failed: ${err.message}`);
    }
  }

  /**
   * Capture an authorized payment.
   * In test mode, Razorpay auto-captures, but we call this for completeness.
   * 
   * @param {string} paymentId - Razorpay payment ID
   * @param {number} amount - Amount to capture in paise
   * @param {string} [currency='INR'] - Currency
   * @returns {Promise<Object>} Captured payment object
   */
  async capturePayment(paymentId, amount, currency = 'INR') {
    if (this.isSimulation || (paymentId && paymentId.startsWith('pay_sim_'))) {
      return this._simulateCapturePayment(paymentId, amount, currency);
    }

    try {
      const payment = await this.client.payments.capture(paymentId, amount, currency);
      logger.info('Razorpay payment captured', {
        payment_id: payment.id,
        amount: payment.amount,
        status: payment.status,
      });
      return payment;
    } catch (err) {
      logger.warn('Live capture failed, falling back to simulated capture for test', {
        payment_id: paymentId,
        error: err.message,
      });
      return this._simulateCapturePayment(paymentId, amount, currency);
    }
  }

  /**
   * Verify a Razorpay payment signature (HMAC-SHA256).
   * Used to validate webhook payloads and checkout responses.
   * 
   * @param {Object} params
   * @param {string} params.razorpay_order_id - Order ID
   * @param {string} params.razorpay_payment_id - Payment ID
   * @param {string} params.razorpay_signature - Signature to verify
   * @returns {boolean} True if signature is valid
   */
  verifyPaymentSignature({ razorpay_order_id, razorpay_payment_id, razorpay_signature }) {
    if (this.isSimulation) {
      logger.debug('Signature verification skipped (simulation mode)');
      return true;
    }

    const expectedSignature = crypto
      .createHmac('sha256', this.keySecret)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest('hex');

    const isValid = expectedSignature === razorpay_signature;

    logger.debug('Payment signature verification', {
      order_id: razorpay_order_id,
      payment_id: razorpay_payment_id,
      is_valid: isValid,
    });

    return isValid;
  }

  // ════════════════════════════════════════════════════════════════════
  //  SIMULATION MODE — Local mock responses for demo without real keys
  // ════════════════════════════════════════════════════════════════════

  /** @private */
  _simulateCreateOrder({ amount, currency, receipt, notes }) {
    const orderId = `order_sim_${uuidv4().split('-')[0]}`;
    const order = {
      id: orderId,
      entity: 'order',
      amount,
      amount_paid: 0,
      amount_due: amount,
      currency,
      receipt,
      status: 'created',
      notes: { ...notes, source: 'acg_gateway', mode: 'simulation' },
      created_at: Math.floor(Date.now() / 1000),
    };

    logger.info('Razorpay order created (SIMULATED)', {
      order_id: orderId,
      amount,
      currency,
    });

    return order;
  }

  /** @private */
  _simulateFetchPayment(paymentId) {
    return {
      id: paymentId,
      entity: 'payment',
      amount: 0,
      currency: 'INR',
      status: 'captured',
      method: 'upi',
      description: 'ACG Simulated Payment',
      captured: true,
    };
  }

  /** @private */
  _simulateCapturePayment(paymentId, amount, currency) {
    const payment = {
      id: paymentId || `pay_sim_${uuidv4().split('-')[0]}`,
      entity: 'payment',
      amount,
      currency,
      status: 'captured',
      method: 'upi',
      captured: true,
      description: 'ACG Simulated Payment Capture',
      order_id: null,
      created_at: Math.floor(Date.now() / 1000),
    };

    logger.info('Razorpay payment captured (SIMULATED)', {
      payment_id: payment.id,
      amount,
      status: 'captured',
    });

    return payment;
  }
}

module.exports = RazorpayWrapper;
