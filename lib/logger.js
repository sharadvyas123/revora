/**
 * @module lib/logger
 * @description Structured JSON logging for the Agentic Commerce Gateway.
 * 
 * Uses Winston with JSON format for machine-parseable logs.
 * Every log entry includes a timestamp and can include contextual
 * metadata (trace_id, agent_id, transaction_id, etc.).
 * 
 * @see docs/design.md Section 5 — Observability Design
 */

const winston = require('winston');
const path = require('path');

/**
 * Log level from environment, defaulting to 'debug' in development.
 * Levels: error, warn, info, http, verbose, debug, silly
 */
const LOG_LEVEL = process.env.LOG_LEVEL || 'debug';

/**
 * Custom format that combines timestamp, level, message, and metadata.
 */
const structuredFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DDTHH:mm:ss.SSSZ' }),
  winston.format.errors({ stack: true }),
  winston.format.json()
);

/**
 * Console format for development — colored, human-readable output.
 */
const consoleFormat = winston.format.combine(
  winston.format.timestamp({ format: 'HH:mm:ss.SSS' }),
  winston.format.colorize(),
  winston.format.printf(({ timestamp, level, message, ...meta }) => {
    const metaStr = Object.keys(meta).length > 0
      ? ` ${JSON.stringify(meta)}`
      : '';
    return `${timestamp} ${level}: ${message}${metaStr}`;
  })
);

/**
 * Main application logger instance.
 * @type {winston.Logger}
 */
const logger = winston.createLogger({
  level: LOG_LEVEL,
  format: structuredFormat,
  defaultMeta: { service: 'acg-gateway' },
  transports: [
    // Console transport with human-readable format
    new winston.transports.Console({
      format: consoleFormat,
    }),
  ],
});

module.exports = logger;
