/**
 * @module gateway/server
 * @description HTTP server entry point for the Agentic Commerce Gateway.
 * 
 * Wires together all middleware, routes, services, and the database layer.
 * Runs on the port specified in .env (default: 3000).
 * 
 * @see docs/architecture.md Section 2.1 — Component Breakdown
 */

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const DatabaseManager = require('../db/database');
const CatalogService = require('./services/catalog.service');
const MandateService = require('./services/mandate.service');
const PaymentService = require('./services/payment.service');
const AuditService = require('./services/audit.service');
const RazorpayWrapper = require('../lib/razorpay');
const createCatalogRoutes = require('./routes/catalog.routes');
const createMandateRoutes = require('./routes/mandate.routes');
const createPaymentRoutes = require('./routes/payment.routes');
const createAuditRoutes = require('./routes/audit.routes');
const { errorHandler } = require('./middleware/error.middleware');
const { createAuditMiddleware } = require('./middleware/audit.middleware');
const logger = require('../lib/logger');

// ── Load config (validates env vars) ────────────────────────────────
let config;
try {
  config = require('../config');
} catch (err) {
  // Config validation failed — error message already printed
  process.exit(1);
}

// ── Initialize Database ─────────────────────────────────────────────
const dbManager = new DatabaseManager(config.db.path);
dbManager.initialize();
logger.info('Database initialized', { path: config.db.path });

// ── Initialize Services ─────────────────────────────────────────────
const auditService = new AuditService(dbManager.db);
const catalogService = new CatalogService(dbManager.db);
const mandateService = new MandateService(dbManager.db, auditService);
const razorpay = new RazorpayWrapper({
  keyId: config.razorpay.keyId,
  keySecret: config.razorpay.keySecret,
});
const paymentService = new PaymentService(dbManager.db, razorpay, auditService);

// ── Create Express App ──────────────────────────────────────────────
const app = express();

// ── Global Middleware ───────────────────────────────────────────────

// Parse JSON request bodies
app.use(express.json());

// Assign a unique trace ID to every request
app.use((req, res, next) => {
  req.traceId = req.headers['x-trace-id'] || uuidv4();
  res.setHeader('X-Trace-Id', req.traceId);
  next();
});

// Run audit middleware globally
app.use(createAuditMiddleware(auditService));

// Request logging
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    logger.http(`${req.method} ${req.originalUrl}`, {
      method: req.method,
      url: req.originalUrl,
      status: res.statusCode,
      duration_ms: duration,
      trace_id: req.traceId,
    });
  });
  next();
});

// ── Health Check ────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  const health = dbManager.db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM merchants) as merchants,
      (SELECT COUNT(*) FROM products) as products,
      (SELECT COUNT(*) FROM variants) as variants,
      (SELECT COUNT(*) FROM agents) as agents
  `).get();

  res.json({
    status: 'healthy',
    service: 'agentic-commerce-gateway',
    version: '1.0.0',
    uptime: process.uptime(),
    database: health,
    timestamp: new Date().toISOString(),
  });
});

// ── API Routes ──────────────────────────────────────────────────────
app.use('/api/v1/catalog', createCatalogRoutes(catalogService));
app.use('/api/v1/mandates', createMandateRoutes(mandateService));
app.use('/api/v1/payments', createPaymentRoutes(paymentService));
app.use('/api/v1/audit', createAuditRoutes(auditService));

// Attach audit service to app for use in other services
app.set('auditService', auditService);

// ── 404 Handler ─────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({
    error: 'NOT_FOUND',
    code: 404,
    message: `Route ${req.method} ${req.originalUrl} not found`,
    timestamp: new Date().toISOString(),
    trace_id: req.traceId,
  });
});

// ── Global Error Handler (must be last) ─────────────────────────────
app.use(errorHandler);

// ── Start Server ────────────────────────────────────────────────────
const PORT = config.server.port;

const server = app.listen(PORT, () => {
  logger.info('═══════════════════════════════════════════════════════════');
  logger.info('  Agentic Commerce Gateway (ACG) — Server Started');
  logger.info(`  Port:        ${PORT}`);
  logger.info(`  Environment: ${config.server.env}`);
  logger.info(`  Database:    ${config.db.path}`);
  logger.info('');
  logger.info('  Available Endpoints:');
  logger.info(`  GET  http://localhost:${PORT}/health`);
  logger.info(`  GET  http://localhost:${PORT}/api/v1/catalog/products`);
  logger.info(`  GET  http://localhost:${PORT}/api/v1/catalog/products/:id`);
  logger.info(`  GET  http://localhost:${PORT}/api/v1/catalog/search?q=...`);
  logger.info('═══════════════════════════════════════════════════════════');
});

// ── Graceful Shutdown ───────────────────────────────────────────────
function shutdown(signal) {
  logger.info(`Received ${signal}. Shutting down gracefully...`);
  server.close(() => {
    dbManager.close();
    logger.info('Server closed.');
    process.exit(0);
  });

  // Force close after 5 seconds
  setTimeout(() => {
    logger.error('Forced shutdown after timeout');
    process.exit(1);
  }, 5000);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

module.exports = app;
