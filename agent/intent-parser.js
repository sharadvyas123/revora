/**
 * @module agent/intent-parser
 * @description Dual-mode purchase intent parser for the AI Buyer Agent.
 *
 * Mode 1 — Gemini LLM (when GEMINI_API_KEY is set):
 *   Uses Google Gemini to semantically understand complex or ambiguous human
 *   purchase instructions. Handles informal language, mixed scripts, and implicit
 *   constraints that regex cannot capture.
 *
 * Mode 2 — Local Rule-Based NLU (fallback when no API key):
 *   Deterministic regex + keyword-matching engine. Works offline, zero latency,
 *   zero cost. Handles well-structured purchase prompts correctly.
 *
 * @see agent/gemini-llm.js — Gemini AI integration layer
 */

require('dotenv').config();
const { isAvailable, parseIntentWithGemini } = require('./gemini-llm');

// ── Category Mapping (Local NLU) ────────────────────────────────────

const CATEGORY_MAP = [
  {
    keywords: ['shoe', 'shoes', 'sneaker', 'sneakers', 'footwear', 'boot', 'boots', 'sandal', 'sandals'],
    category: 'footwear',
  },
  {
    keywords: ['shirt', 'tee', 'tshirt', 't-shirt', 'top', 'jersey', 'apparel', 'clothing', 'jacket', 'hoodie'],
    category: 'apparel',
  },
  {
    keywords: ['watch', 'smartwatch', 'gadget', 'electronics', 'earbuds', 'headphones', 'tracker'],
    category: 'electronics',
  },
];

const STOPWORDS = new Set([
  'a', 'an', 'the', 'i', 'me', 'my', 'we', 'our', 'you', 'your',
  'buy', 'get', 'find', 'search', 'want', 'need', 'looking', 'for',
  'some', 'good', 'best', 'nice', 'great', 'please', 'can', 'could',
  'would', 'like', 'of', 'in', 'on', 'at', 'to', 'with', 'and', 'or',
  'under', 'below', 'within', 'max', 'maximum', 'less', 'than',
  'rupees', 'rupee', 'rs', 'inr', 'pair', 'pairs',
  'around', 'about', 'approximately', 'near', 'cheap', 'affordable',
]);

// ════════════════════════════════════════════════════════════════════
//  PUBLIC API
// ════════════════════════════════════════════════════════════════════

/**
 * Parse a natural language purchase prompt into structured intent.
 *
 * Automatically selects Gemini LLM mode if GEMINI_API_KEY is configured,
 * otherwise falls back to the local regex NLU engine.
 *
 * @param {string} prompt - Human's raw instruction (e.g. "buy running shoes under ₹3000")
 * @returns {Promise<Object>} Parsed intent:
 *   { keywords, category, max_price, currency, quantity, raw_prompt,
 *     llm_mode: 'gemini' | 'local' }
 */
async function parseIntent(prompt) {
  if (!prompt || typeof prompt !== 'string') {
    throw new Error('Intent parser requires a non-empty string prompt');
  }

  if (isAvailable()) {
    try {
      const result = await parseIntentWithGemini(prompt);
      return { ...result, llm_mode: 'gemini' };
    } catch (err) {
      // Gemini call failed — fall through to local NLU
      console.warn(`  ⚠ Gemini intent parsing failed (${err.message}), falling back to local NLU`);
    }
  }

  // Local NLU fallback
  return parseIntentLocal(prompt);
}

// ════════════════════════════════════════════════════════════════════
//  LOCAL NLU ENGINE (deterministic fallback)
// ════════════════════════════════════════════════════════════════════

/**
 * Local regex/rule-based intent extractor.
 * @param {string} prompt
 * @returns {Object} Parsed intent with llm_mode: 'local'
 */
function parseIntentLocal(prompt) {
  const normalized = prompt.toLowerCase().trim();

  return {
    keywords:    extractKeywords(normalized),
    category:    detectCategory(normalized),
    max_price:   extractPrice(normalized),
    currency:    'INR',
    quantity:    extractQuantity(normalized),
    raw_prompt:  prompt,
    llm_mode:   'local',
  };
}

/**
 * Extract the maximum price from the prompt.
 * Matches: "under 3000", "below ₹3,000", "max 5000 rupees", "within 2500"
 * @param {string} text - Normalized (lowercase) prompt
 * @returns {number|null} Price in paise, or null
 */
function extractPrice(text) {
  const pricePatterns = [
    /(?:under|below|within|max|maximum|less\s+than|upto|up\s+to|budget\s+(?:of|is)?)\s*₹?\s*([\d,]+(?:\.\d{1,2})?)\s*(?:rupees?|rs\.?|inr)?/i,
    /₹\s*([\d,]+(?:\.\d{1,2})?)/i,
    /(\d{3,})\s*(?:rupees?|rs\.?|inr)/i,
  ];

  for (const pattern of pricePatterns) {
    const match = text.match(pattern);
    if (match) {
      const amount = parseFloat(match[1].replace(/,/g, ''));
      if (!isNaN(amount) && amount > 0) return Math.round(amount * 100);
    }
  }
  return null;
}

/**
 * Extract quantity from the prompt (e.g. "2 pairs").
 * @param {string} text
 * @returns {number} Quantity (default 1)
 */
function extractQuantity(text) {
  const qtyMatch = text.match(/(\d+)\s*(?:pairs?|units?|pieces?|items?|of)/i);
  if (qtyMatch) {
    const qty = parseInt(qtyMatch[1], 10);
    if (qty > 0 && qty <= 100) return qty;
  }
  return 1;
}

/**
 * Detect product category from keyword mapping.
 * @param {string} text
 * @returns {string|null}
 */
function detectCategory(text) {
  const words = text.split(/\s+/);
  for (const mapping of CATEGORY_MAP) {
    for (const keyword of mapping.keywords) {
      if (words.includes(keyword)) return mapping.category;
    }
  }
  return null;
}

/**
 * Extract significant search keywords, removing stopwords and price tokens.
 * @param {string} text
 * @returns {string[]}
 */
function extractKeywords(text) {
  const cleaned = text
    .replace(/₹?\s*[\d,]+(?:\.\d{1,2})?\s*(?:rupees?|rs\.?|inr)?/gi, '')
    .replace(/[^\w\s-]/g, ' ');

  const words = cleaned.split(/\s+/).filter(Boolean);
  const keywords = words.filter(w => w.length >= 2 && !STOPWORDS.has(w) && !/^\d+$/.test(w));
  return [...new Set(keywords)];
}

module.exports = {
  parseIntent,
  // Export local helpers for testing
  parseIntentLocal,
  extractPrice,
  extractQuantity,
  detectCategory,
  extractKeywords,
};
