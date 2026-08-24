/**
 * @module config/index
 * @description Environment-based configuration loader for the Agentic Commerce Gateway.
 * 
 * Loads environment variables from .env file and validates that all required
 * configuration values are present at startup. If any required variable is
 * missing, the process exits immediately with a clear error message.
 * 
 * @see docs/architecture.md Section 5.1 — Environment Configuration
 * @see docs/design.md Section 6.1 — Secret Management
 */

const path = require('path');
const dotenv = require('dotenv');

// Load .env file from project root
dotenv.config({ path: path.join(__dirname, '..', '.env') });

/**
 * Required environment variables — process exits if any are missing.
 * @type {string[]}
 */
const REQUIRED_VARS = [
  'RAZORPAY_KEY_ID',
  'RAZORPAY_KEY_SECRET',
  'JWT_SECRET',
];

/**
 * Validate that all required environment variables are set.
 * Exits the process with code 1 if any are missing.
 */
function validateEnv() {
  const missing = REQUIRED_VARS.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    console.error('');
    console.error('═══════════════════════════════════════════════════════════');
    console.error('  FATAL: Missing required environment variables:');
    console.error('');
    missing.forEach((key) => {
      console.error(`    ✗  ${key}`);
    });
    console.error('');
    console.error('  Create a .env file from the template:');
    console.error('    cp .env.example .env');
    console.error('');
    console.error('  Then fill in the required values.');
    console.error('═══════════════════════════════════════════════════════════');
    console.error('');
    process.exit(1);
  }
}

// Validate on import
validateEnv();

/**
 * Application configuration object.
 * All values sourced from environment variables with sensible defaults.
 * 
 * @typedef {Object} Config
 * @property {Object} server - Server configuration
 * @property {Object} razorpay - Razorpay API configuration (test mode)
 * @property {Object} jwt - JWT mandate token configuration
 * @property {Object} db - Database configuration
 * @property {Object} llm - LLM API configuration for agent simulator
 * @property {Object} logging - Logging configuration
 */
const config = {
  /** Server configuration */
  server: {
    port: parseInt(process.env.PORT, 10) || 3000,
    env: process.env.NODE_ENV || 'development',
    isDev: (process.env.NODE_ENV || 'development') === 'development',
  },

  /** Razorpay API configuration (test mode) */
  razorpay: {
    keyId: process.env.RAZORPAY_KEY_ID,
    keySecret: process.env.RAZORPAY_KEY_SECRET,
    baseUrl: 'https://api.razorpay.com/v1',
    webhookSecret: process.env.RAZORPAY_WEBHOOK_SECRET || '',
  },

  /** JWT mandate token configuration */
  jwt: {
    secret: process.env.JWT_SECRET,
    expiry: parseInt(process.env.JWT_EXPIRY, 10) || 3600,        // Default 1 hour
    issuer: 'acg_system',
    audience: 'acg_agent',
  },

  /** Database configuration */
  db: {
    path: process.env.DB_PATH || path.join(__dirname, '..', 'data', 'acg.sqlite'),
  },

  /** LLM API configuration for the buyer agent simulator */
  llm: {
    openaiApiKey: process.env.OPENAI_API_KEY || '',
    geminiApiKey: process.env.GEMINI_API_KEY || '',
    model: process.env.LLM_MODEL || 'gpt-4o',
    maxTokens: parseInt(process.env.LLM_MAX_TOKENS, 10) || 1024,
    temperature: parseFloat(process.env.LLM_TEMPERATURE) || 0.2,
  },

  /** Logging configuration */
  logging: {
    level: process.env.LOG_LEVEL || 'debug',
  },
};

module.exports = config;
