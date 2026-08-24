/**
 * @module gateway/middleware/validate
 * @description Zod schema validation middleware for the Agentic Commerce Gateway.
 * 
 * Creates Express middleware that validates request query, params, or body
 * against a Zod schema. On validation failure, returns a structured
 * VALIDATION_ERROR response per the error taxonomy.
 * 
 * @see docs/design.md Section 2.7 — Layered Validation
 * @see docs/backend_schema.md Section 7 — Data Validation (Zod Schemas)
 */

const { ValidationError } = require('../../lib/errors');

/**
 * Create validation middleware for a specific request part.
 * 
 * @param {import('zod').ZodSchema} schema - Zod schema to validate against
 * @param {'query'|'body'|'params'} source - Which part of the request to validate
 * @returns {Function} Express middleware function
 * 
 * @example
 * const { z } = require('zod');
 * const { validate } = require('./validate.middleware');
 * 
 * const querySchema = z.object({ q: z.string().min(1) });
 * router.get('/search', validate(querySchema, 'query'), handler);
 */
function validate(schema, source = 'body') {
  return (req, res, next) => {
    const data = req[source];
    const result = schema.safeParse(data);

    if (!result.success) {
      const errors = result.error.issues.map((issue) => ({
        field: issue.path.join('.'),
        message: issue.message,
        code: issue.code,
        ...(issue.expected && { expected: issue.expected }),
        ...(issue.received && { received: issue.received }),
      }));

      const err = new ValidationError(errors);
      return res.status(err.statusCode).json(err.toJSON(req.traceId));
    }

    // Replace the source data with the parsed (and coerced) values
    req[source] = result.data;
    next();
  };
}

module.exports = { validate };
