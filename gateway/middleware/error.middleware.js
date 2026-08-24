/**
 * @module gateway/middleware/error
 * @description Global error handling middleware for the Agentic Commerce Gateway.
 * 
 * Catches all errors (thrown or passed via next(err)) and formats them
 * into the structured error response format defined in the TRD.
 * 
 * Every error response includes:
 * - error: machine-readable code for agents
 * - code: HTTP status
 * - message: human-readable explanation
 * - details: contextual debugging info
 * - recovery: suggested next action for the agent
 * - timestamp and trace_id
 * 
 * @see docs/design.md Section 2.5 — Structured Errors
 * @see docs/TRD.md Section 7.2 — Error Response Format
 */

const { ACGError } = require('../../lib/errors');
const logger = require('../../lib/logger');

/**
 * Global error handling middleware.
 * Must be registered LAST in the Express middleware chain (4-argument signature).
 * 
 * @param {Error} err - The error object
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
function errorHandler(err, req, res, next) {
  // If it's one of our custom ACGErrors, use its structured format
  if (err instanceof ACGError) {
    logger.warn(`${err.code}: ${err.message}`, {
      code: err.code,
      statusCode: err.statusCode,
      details: err.details,
      trace_id: req.traceId,
    });

    return res.status(err.statusCode).json(err.toJSON(req.traceId));
  }

  // For unexpected errors, log the full stack and return a generic 500
  logger.error(`Unhandled error: ${err.message}`, {
    stack: err.stack,
    trace_id: req.traceId,
  });

  return res.status(500).json({
    error: 'INTERNAL_ERROR',
    code: 500,
    message: 'An unexpected error occurred',
    timestamp: new Date().toISOString(),
    ...(req.traceId && { trace_id: req.traceId }),
  });
}

module.exports = { errorHandler };
