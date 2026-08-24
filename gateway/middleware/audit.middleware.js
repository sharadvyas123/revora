/**
 * @module gateway/middleware/audit.middleware
 * @description Auto-audit middleware for the Agentic Commerce Gateway.
 * 
 * Automatically attaches an AuditService instance to every request
 * and provides helpers for logging audit events without manual boilerplate.
 * 
 * Usage in route handlers:
 *   req.audit.logRequest(auditTrailId, { ... })
 *   req.audit.logPayment(auditTrailId, { ... })
 * 
 * @see docs/TRD.md Section 6 — Audit Trail
 */

const { v4: uuidv4 } = require('uuid');

/**
 * Create audit middleware that attaches the audit service to every request.
 * 
 * @param {import('../services/audit.service')} auditService - AuditService instance
 * @returns {Function} Express middleware
 */
function createAuditMiddleware(auditService) {
  return (req, res, next) => {
    // Attach audit service for route handlers to use
    req.audit = auditService;

    // Generate or inherit an audit trail ID for this request
    req.auditTrailId = req.headers['x-audit-trail-id'] || `audit_${uuidv4().split('-')[0]}`;
    res.setHeader('X-Audit-Trail-Id', req.auditTrailId);

    next();
  };
}

module.exports = { createAuditMiddleware };
