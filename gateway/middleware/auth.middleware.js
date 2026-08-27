/**
 * @module gateway/middleware/auth.middleware
 * @description Authentication & Authorization middleware for the Agentic Commerce Gateway.
 *
 * Provides two independent security layers:
 *
 *   1. `authenticateAgent(db)`:
 *      Validates agent identity from request headers against the SQLite agents table.
 *      Supports: x-agent-id header, x-api-key header, Authorization: Bearer <key>.
 *      On success: attaches req.agent for downstream route handlers.
 *
 *   2. `requireMandateToken()`:
 *      Verifies the cryptographic JWT Mandate Token on sensitive payment endpoints.
 *      On success: attaches req.mandateTokenPayload with decoded claims.
 *
 * Middleware is applied selectively:
 *   - Public:    /health, /api/v1/catalog, /api/v1/audit
 *   - Protected: /api/v1/mandates, /api/v1/payments (authenticateAgent required)
 *
 * @see docs/TRD.md Section 4 — Security & Mandates
 */

const { verifyMandateToken } = require('../../lib/jwt');
const logger = require('../../lib/logger');

/**
 * Middleware factory: verify agent identity against the database.
 *
 * Reads identity from (in priority order):
 *   1. `x-agent-id` request header
 *   2. `x-api-key` request header
 *   3. `Authorization: Bearer <agent_id>` header
 *   4. `agent_id` in JSON body
 *
 * If no identity is provided, the request proceeds unblocked (anonymous).
 * Identity is only enforced when the header is present.
 *
 * @param {import('better-sqlite3').Database} db - Live SQLite database instance
 * @returns {Function} Express middleware
 */
function authenticateAgent(db) {
  return (req, res, next) => {
    // Resolve agent identity from multiple possible locations
    const agentId =
      req.headers['x-agent-id'] ||
      req.headers['x-api-key'] ||
      (req.headers.authorization && req.headers.authorization.startsWith('Bearer ')
        ? req.headers.authorization.slice(7)
        : null) ||
      req.body?.agent_id ||
      req.query?.agent_id;

    // No identity provided — allow through (public access)
    if (!agentId) {
      return next();
    }

    // Look up agent in the database
    const agent = db.prepare('SELECT * FROM agents WHERE agent_id = ?').get(agentId);

    if (!agent) {
      logger.warn('Unauthorized agent attempt', {
        agent_id: agentId,
        method: req.method,
        url: req.originalUrl,
        trace_id: req.traceId,
      });

      return res.status(401).json({
        status: 'error',
        error: 'UNAUTHORIZED_AGENT',
        code: 401,
        message: `Agent "${agentId}" is not registered in this gateway`,
        timestamp: new Date().toISOString(),
        trace_id: req.traceId,
      });
    }

    if (agent.status !== 'ACTIVE') {
      logger.warn('Suspended agent attempt', {
        agent_id: agentId,
        status: agent.status,
        trace_id: req.traceId,
      });

      return res.status(403).json({
        status: 'error',
        error: 'AGENT_SUSPENDED',
        code: 403,
        message: `Agent "${agentId}" is currently ${agent.status} and cannot perform operations`,
        timestamp: new Date().toISOString(),
        trace_id: req.traceId,
      });
    }

    // Attach verified agent to request for downstream use
    req.agent = agent;
    logger.debug('Agent authenticated', { agent_id: agentId, trace_id: req.traceId });

    next();
  };
}

/**
 * Middleware: strictly require a valid cryptographic JWT Mandate Token.
 *
 * Reads token from:
 *   1. `Authorization: Bearer <jwt>` header
 *   2. `mandate_token` field in JSON body
 *
 * On success attaches `req.mandateTokenPayload` with decoded mandate claims.
 *
 * @returns {Function} Express middleware
 */
function requireMandateToken() {
  return (req, res, next) => {
    const authHeader = req.headers.authorization;

    const token =
      (authHeader && authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null) ||
      req.body?.mandate_token ||
      null;

    if (!token) {
      return res.status(401).json({
        status: 'error',
        error: 'MANDATE_TOKEN_REQUIRED',
        code: 401,
        message: 'A cryptographically signed JWT mandate token is required. Include it as: Authorization: Bearer <token>',
        timestamp: new Date().toISOString(),
        trace_id: req.traceId,
      });
    }

    try {
      const decoded = verifyMandateToken(token);
      req.mandateTokenPayload = decoded;

      logger.debug('Mandate token verified', {
        mandate_id: decoded.mandate_id,
        mandate_type: decoded.mandate_type,
        agent_id: decoded.agent_id,
        trace_id: req.traceId,
      });

      next();
    } catch (err) {
      logger.warn('Invalid mandate token', { error: err.message, trace_id: req.traceId });

      return res.status(403).json({
        status: 'error',
        error: 'INVALID_MANDATE_TOKEN',
        code: 403,
        message: `Mandate token verification failed: ${err.message}`,
        timestamp: new Date().toISOString(),
        trace_id: req.traceId,
      });
    }
  };
}

module.exports = { authenticateAgent, requireMandateToken };
