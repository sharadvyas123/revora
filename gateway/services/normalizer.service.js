/**
 * @module gateway/services/normalizer.service
 * @description Product Normalizer for the Agentic Commerce Gateway v2.
 *
 * Converts product records from any source (local SQLite catalog or
 * external web crawler cache) into a single, unified Normalized Product
 * Schema. Downstream agents always receive the same shape regardless of
 * where the product was discovered.
 *
 * Unified schema shape:
 * {
 *   product_id:   string,
 *   source_type:  "LOCAL_CATALOG" | "EXTERNAL_WEB",
 *   source_name:  string,
 *   source_url:   string,
 *   name:         string,
 *   description:  string,
 *   category:     string,
 *   subcategory:  string,
 *   price:        { amount: number, currency: string, display: string },
 *   stock:        { available: boolean, quantity: number },
 *   rating:       number | null,
 *   review_count: number,
 *   attributes:   object,
 *   policies:     object,
 *   merchant_id:  string | null,
 *   fetched_at:   string (ISO-8601),
 * }
 *
 * @see docs/TRD.md Section 3.4 — Normalized Product Schema
 * @see docs/ticket_01_multi_source_discovery.md Section 2.2
 */

const logger = require('../../lib/logger');

/** Base URL used for local catalog product detail pages. */
const LOCAL_BASE_URL = 'http://localhost:3000/api/v1/catalog/products';

class NormalizerService {
  // ── Public Methods ───────────────────────────────────────────────

  /**
   * Normalize a raw products table row + its variants array into the
   * Unified Normalized Product Schema.
   *
   * @param {Object} productRow   - Raw SQLite row from the `products` table
   * @param {Object[]} [variants] - Array of raw rows from the `variants` table
   * @returns {Object} Normalized product payload
   */
  normalizeLocal(productRow, variants = []) {
    const p = productRow;

    const normalizedVariants = variants.map((v) => ({
      variant_id: v.variant_id,
      attributes: this._safeParseJSON(v.attributes, {}),
      price_override: v.price_override ?? null,
      stock: {
        available: v.stock_available === 1,
        quantity: v.stock_quantity,
      },
    }));

    const normalized = {
      product_id:   p.product_id,
      source_type:  'LOCAL_CATALOG',
      source_name:  'ACG Local Catalog',
      source_url:   `${LOCAL_BASE_URL}/${p.product_id}`,
      name:         p.name || '',
      description:  p.description || '',
      category:     p.category || '',
      subcategory:  p.subcategory || '',
      price: {
        amount:   p.price_amount,
        currency: p.price_currency || 'INR',
        display:  this._formatPrice(p.price_amount, p.price_currency || 'INR'),
      },
      stock: {
        available: p.stock_available === 1,
        quantity:  p.stock_quantity,
        low_stock_threshold: p.low_stock_threshold ?? null,
      },
      variants:     normalizedVariants,
      rating:       p.rating ?? null,
      review_count: p.review_count ?? 0,
      attributes:   {},
      policies:     this._safeParseJSON(p.policies, {}),
      media:        this._safeParseJSON(p.media, []),
      merchant_id:  p.merchant_id || null,
      fetched_at:   p.updated_at || new Date().toISOString(),
    };

    logger.debug('[NormalizerService] normalizeLocal', {
      product_id: normalized.product_id,
      source_type: normalized.source_type,
    });

    return normalized;
  }

  /**
   * Normalize a raw external_products table row into the Unified
   * Normalized Product Schema.  The normalized_payload JSON stored
   * in the DB is already partially normalized — this method validates
   * and fills any missing fields.
   *
   * @param {Object} externalRow - Raw SQLite row from `external_products`
   * @returns {Object} Normalized product payload
   */
  normalizeExternal(externalRow) {
    const raw = this._safeParseJSON(externalRow.normalized_payload, {});

    // Merge DB metadata with payload fields, payload fields take precedence
    const priceAmount   = raw.price?.amount ?? 0;
    const priceCurrency = raw.price?.currency ?? 'INR';

    const normalized = {
      product_id:   externalRow.external_id,
      source_type:  'EXTERNAL_WEB',
      source_name:  externalRow.source_name || raw.source_name || 'External',
      source_url:   externalRow.source_url  || raw.source_url  || '',
      name:         raw.name        || '',
      description:  raw.description || '',
      category:     raw.category    || '',
      subcategory:  raw.subcategory || '',
      price: {
        amount:   priceAmount,
        currency: priceCurrency,
        display:  this._formatPrice(priceAmount, priceCurrency),
      },
      stock: {
        available: raw.stock?.available ?? true,
        quantity:  raw.stock?.quantity  ?? null,
        low_stock_threshold: null,
      },
      variants:     [],
      rating:       raw.rating       ?? null,
      review_count: raw.review_count ?? 0,
      attributes:   raw.attributes   ?? {},
      policies:     raw.policies     ?? {},
      media:        raw.media        ?? [],
      merchant_id:  raw.merchant_id  ?? null,
      fetched_at:   externalRow.fetched_at || new Date().toISOString(),
    };

    logger.debug('[NormalizerService] normalizeExternal', {
      external_id: externalRow.external_id,
      source_name: normalized.source_name,
    });

    return normalized;
  }

  // ── Private Helpers ──────────────────────────────────────────────

  /**
   * Format a price amount (in paise) to a human-readable INR string.
   * @param {number} amount   - Amount in paise
   * @param {string} currency - ISO currency code (default INR)
   * @returns {string} e.g. "₹2,799.00"
   * @private
   */
  _formatPrice(amount, currency = 'INR') {
    if (currency === 'INR') {
      return `₹${(amount / 100).toLocaleString('en-IN', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      })}`;
    }
    return `${currency} ${(amount / 100).toFixed(2)}`;
  }

  /**
   * Safely parse a JSON string, returning a fallback on parse error.
   * @param {string|null} jsonStr
   * @param {*} fallback
   * @returns {*}
   * @private
   */
  _safeParseJSON(jsonStr, fallback) {
    if (!jsonStr) return fallback;
    try {
      return JSON.parse(jsonStr);
    } catch {
      return fallback;
    }
  }
}

module.exports = NormalizerService;
