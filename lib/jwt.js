/**
 * @module lib/jwt
 * @description JWT utilities for mandate token creation and verification.
 * 
 * Mandate tokens are HS256-signed JWTs that carry embedded constraint claims:
 * - max_amount: Maximum spend in paise
 * - allowed_categories: Array of permitted product categories
 * - allowed_merchants: Array of permitted merchant IDs
 * - single_use: Whether the mandate can only be used once
 * - mandate_type: INTENT | CART | PAYMENT
 * 
 * The token is the cryptographic proof of bounded authorization.
 * Every mandate operation verifies the token before proceeding.
 * 
 * @see docs/TRD.md Section 4 — Mandate Token Specification
 * @see docs/design.md Section 3.2 — JWT Mandate Tokens
 */

const jwt = require('jsonwebtoken');
const logger = require('./logger');
const { InvalidTokenError } = require('./errors');

// Load config — but handle the case where we're used standalone
let JWT_SECRET, JWT_EXPIRY, JWT_ISSUER, JWT_AUDIENCE;
try {
  const config = require('../config');
  JWT_SECRET = config.jwt.secret;
  JWT_EXPIRY = config.jwt.expiry;
  JWT_ISSUER = config.jwt.issuer;
  JWT_AUDIENCE = config.jwt.audience;
} catch {
  JWT_SECRET = process.env.JWT_SECRET || 'acg-hackathon-secret-key-2026';
  JWT_EXPIRY = parseInt(process.env.JWT_EXPIRY, 10) || 3600;
  JWT_ISSUER = 'acg_system';
  JWT_AUDIENCE = 'acg_agent';
}

/**
 * Create a signed mandate token with embedded constraint claims.
 * 
 * @param {Object} payload - Token payload
 * @param {string} payload.mandate_id - Unique mandate identifier
 * @param {string} payload.mandate_type - INTENT | CART | PAYMENT
 * @param {string} payload.delegator_id - Human who authorized this mandate
 * @param {string} payload.agent_id - AI agent this mandate is issued to
 * @param {Object} payload.constraints - Spending constraints
 * @param {number} payload.constraints.max_amount - Max amount in paise
 * @param {string} payload.constraints.currency - Currency code (default: INR)
 * @param {string[]} [payload.constraints.allowed_categories] - Permitted categories
 * @param {string[]} [payload.constraints.allowed_merchants] - Permitted merchants
 * @param {boolean} [payload.constraints.single_use] - If true, mandate is one-time-use
 * @param {string} [payload.parent_mandate_id] - Parent mandate in the chain
 * @param {Object} [payload.cart] - Cart details (for CART/PAYMENT mandates)
 * @param {number} [expiresIn] - Override TTL in seconds (default: config value)
 * @returns {string} Signed JWT token string
 */
function createMandateToken(payload, expiresIn = JWT_EXPIRY) {
  const tokenPayload = {
    // Standard claims
    sub: payload.agent_id,
    iss: JWT_ISSUER,
    aud: JWT_AUDIENCE,

    // Mandate-specific claims
    mandate_id: payload.mandate_id,
    mandate_type: payload.mandate_type,
    delegator_id: payload.delegator_id,
    agent_id: payload.agent_id,
    constraints: payload.constraints,

    // Chain reference
    ...(payload.parent_mandate_id && { parent_mandate_id: payload.parent_mandate_id }),

    // Cart details (for CART and PAYMENT mandates)
    ...(payload.cart && { cart: payload.cart }),
  };

  const token = jwt.sign(tokenPayload, JWT_SECRET, {
    algorithm: 'HS256',
    expiresIn,
  });

  logger.debug('JWT mandate token created', {
    mandate_id: payload.mandate_id,
    mandate_type: payload.mandate_type,
    agent_id: payload.agent_id,
    expires_in: expiresIn,
  });

  return token;
}

/**
 * Verify and decode a mandate token.
 * 
 * @param {string} token - JWT token string to verify
 * @returns {Object} Decoded token payload with all claims
 * @throws {InvalidTokenError} If token is invalid, expired, or tampered
 */
function verifyMandateToken(token) {
  try {
    const decoded = jwt.verify(token, JWT_SECRET, {
      algorithms: ['HS256'],
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
    });

    return decoded;
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      throw new InvalidTokenError('Mandate token has expired');
    }
    if (err.name === 'JsonWebTokenError') {
      throw new InvalidTokenError(`Invalid mandate token: ${err.message}`);
    }
    throw new InvalidTokenError('Failed to verify mandate token');
  }
}

/**
 * Decode a token WITHOUT verifying the signature.
 * Used only for logging/debugging — never for authorization decisions.
 * 
 * @param {string} token - JWT token string
 * @returns {Object|null} Decoded payload or null if malformed
 */
function decodeMandateToken(token) {
  try {
    return jwt.decode(token);
  } catch {
    return null;
  }
}

module.exports = {
  createMandateToken,
  verifyMandateToken,
  decodeMandateToken,
};
