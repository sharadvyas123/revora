/**
 * @module gateway/services/catalog.service
 * @description Catalog business logic for the Agentic Commerce Gateway.
 * 
 * Exposes the merchant's product catalog as structured, machine-readable data
 * aligned with the ACP Product Feed Specification. Supports:
 * - Filtered product listing (category, price range, stock availability)
 * - Single product detail with full variant list
 * - Keyword search with relevance scoring and ranking
 * 
 * All prices are in paise (₹1 = 100 paise). All responses use the
 * ACP Product Feed schema format.
 * 
 * @see docs/TRD.md Section 3.1 — Catalog API
 * @see docs/backend_schema.md Section 5.1 — Catalog Queries
 * @see docs/PRD.md Section 5 — F1: Agent-Readable Catalog Service
 */

const logger = require('../../lib/logger');
const { ProductNotFoundError } = require('../../lib/errors');

class CatalogService {
  /**
   * @param {import('better-sqlite3').Database} db - The better-sqlite3 database instance
   */
  constructor(db) {
    this.db = db;
    this.defaultMerchantId = 'merch_sportshub'; // Single merchant for hackathon
  }

  /**
   * List products with optional filtering and pagination.
   * 
   * @param {Object} filters
   * @param {string} [filters.category] - Filter by product category
   * @param {number} [filters.min_price] - Minimum price in paise
   * @param {number} [filters.max_price] - Maximum price in paise
   * @param {boolean} [filters.in_stock] - Filter by availability
   * @param {number} [filters.page=1] - Page number (1-indexed)
   * @param {number} [filters.limit=20] - Items per page (max 100)
   * @returns {Object} Paginated product list in ACP format
   */
  findAll(filters = {}) {
    const {
      category,
      min_price,
      max_price,
      in_stock,
      page = 1,
      limit = 20,
    } = filters;

    const offset = (page - 1) * limit;

    // Build WHERE clauses dynamically
    const conditions = ['p.merchant_id = ?'];
    const params = [this.defaultMerchantId];

    if (category) {
      conditions.push('p.category = ?');
      params.push(category);
    }
    if (min_price !== undefined && min_price !== null) {
      conditions.push('p.price_amount >= ?');
      params.push(min_price);
    }
    if (max_price !== undefined && max_price !== null) {
      conditions.push('p.price_amount <= ?');
      params.push(max_price);
    }
    if (in_stock === true || in_stock === 'true') {
      conditions.push('p.stock_available = 1');
    }

    const whereClause = conditions.join(' AND ');

    // Get total count for pagination
    const countRow = this.db.prepare(
      `SELECT COUNT(*) as total FROM products p WHERE ${whereClause}`
    ).get(...params);

    const total = countRow.total;

    // Fetch products
    const products = this.db.prepare(`
      SELECT p.*
      FROM products p
      WHERE ${whereClause}
      ORDER BY p.price_amount ASC
      LIMIT ? OFFSET ?
    `).all(...params, limit, offset);

    // Fetch variants for each product and format
    const formattedProducts = products.map((p) => this._formatProduct(p));

    logger.debug('Catalog findAll', {
      filters,
      total,
      returned: formattedProducts.length,
    });

    return {
      products: formattedProducts,
      pagination: {
        page,
        limit,
        total,
        has_more: offset + limit < total,
      },
    };
  }

  /**
   * Get a single product by ID with full variant list.
   * 
   * @param {string} productId - The product ID
   * @returns {Object} Full product detail in ACP format
   * @throws {ProductNotFoundError} If product doesn't exist
   */
  findById(productId) {
    const product = this.db.prepare(
      'SELECT * FROM products WHERE product_id = ?'
    ).get(productId);

    if (!product) {
      throw new ProductNotFoundError(productId);
    }

    const formatted = this._formatProduct(product);

    logger.debug('Catalog findById', { product_id: productId });

    return formatted;
  }

  /**
   * Search products by keyword with relevance scoring.
   * 
   * Uses SQL LIKE-based matching with weighted scoring:
   * - Name match: 10 points
   * - Description match: 5 points
   * - Category/subcategory match: 3 points
   * 
   * Results are ranked by relevance_score DESC, then rating DESC.
   * Only returns in-stock products by default.
   * 
   * @param {Object} params
   * @param {string} params.q - Search query string
   * @param {number} [params.max_price] - Maximum price in paise
   * @param {string} [params.category] - Category filter
   * @param {number} [params.limit=5] - Max results (default 5)
   * @returns {Object} Search results with relevance scores and match reasons
   */
  search({ q, max_price, category, limit = 5 }) {
    // Split query into individual keywords for broader matching
    const keywords = q.toLowerCase().split(/\s+/).filter(Boolean);

    // Build the relevance scoring expression
    // Each keyword that matches a field adds to the relevance score
    let scoreCases = [];
    let whereOrs = [];
    const params = [];

    for (const keyword of keywords) {
      // Score for name match (highest weight)
      scoreCases.push(`CASE WHEN LOWER(p.name) LIKE '%' || ? || '%' THEN 10 ELSE 0 END`);
      params.push(keyword);

      // Score for description match
      scoreCases.push(`CASE WHEN LOWER(p.description) LIKE '%' || ? || '%' THEN 5 ELSE 0 END`);
      params.push(keyword);

      // Score for category match
      scoreCases.push(`CASE WHEN LOWER(p.category) LIKE '%' || ? || '%' THEN 3 ELSE 0 END`);
      params.push(keyword);

      // Score for subcategory match
      scoreCases.push(`CASE WHEN LOWER(p.subcategory) LIKE '%' || ? || '%' THEN 3 ELSE 0 END`);
      params.push(keyword);

      // WHERE clause: product must match at least one keyword in at least one field
      whereOrs.push(`(
        LOWER(p.name) LIKE '%' || ? || '%'
        OR LOWER(p.description) LIKE '%' || ? || '%'
        OR LOWER(p.category) LIKE '%' || ? || '%'
        OR LOWER(p.subcategory) LIKE '%' || ? || '%'
      )`);
      params.push(keyword, keyword, keyword, keyword);
    }

    const scoreExpr = scoreCases.join(' + ');
    const matchExpr = whereOrs.join(' OR ');

    // Build additional filters
    const extraConditions = ['p.merchant_id = ?'];
    params.push(this.defaultMerchantId);

    // Only in-stock products for search results
    extraConditions.push('p.stock_available = 1');

    if (max_price !== undefined && max_price !== null) {
      extraConditions.push('p.price_amount <= ?');
      params.push(max_price);
    }
    if (category) {
      extraConditions.push('p.category = ?');
      params.push(category);
    }

    const extraWhere = extraConditions.join(' AND ');

    const sql = `
      SELECT p.*, (${scoreExpr}) as relevance_score
      FROM products p
      WHERE (${matchExpr})
        AND ${extraWhere}
      ORDER BY relevance_score DESC, p.rating DESC
      LIMIT ?
    `;
    params.push(limit);

    const rows = this.db.prepare(sql).all(...params);

    // Format results with relevance metadata
    const results = rows.map((row) => {
      const product = this._formatProduct(row);
      const matchReasons = this._generateMatchReason(row, keywords);

      return {
        product,
        relevance_score: row.relevance_score / (keywords.length * 21), // Normalize to 0–1
        match_reason: matchReasons,
      };
    });

    logger.debug('Catalog search', {
      query: q,
      keywords,
      total_matches: results.length,
    });

    return {
      query: q,
      results,
      total_matches: results.length,
    };
  }

  // ── Private Helpers ──────────────────────────────────────────────

  /**
   * Format a raw database product row into the ACP Product Feed schema.
   * Fetches variants and parses JSON fields.
   * 
   * @param {Object} row - Raw SQLite row from products table
   * @returns {Object} ACP-formatted product object
   * @private
   */
  _formatProduct(row) {
    // Fetch variants for this product
    const variants = this.db.prepare(
      'SELECT * FROM variants WHERE product_id = ?'
    ).all(row.product_id);

    const formattedVariants = variants.map((v) => ({
      variant_id: v.variant_id,
      attributes: this._safeParseJSON(v.attributes, {}),
      price_override: v.price_override,
      stock: {
        available: v.stock_available === 1,
        quantity: v.stock_quantity,
      },
    }));

    return {
      product_id: row.product_id,
      name: row.name,
      description: row.description,
      category: row.category,
      subcategory: row.subcategory,
      price: {
        amount: row.price_amount,
        currency: row.price_currency,
        display: `₹${(row.price_amount / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`,
      },
      stock: {
        available: row.stock_available === 1,
        quantity: row.stock_quantity,
        low_stock_threshold: row.low_stock_threshold,
      },
      variants: formattedVariants,
      media: this._safeParseJSON(row.media, []),
      policies: this._safeParseJSON(row.policies, {}),
      rating: row.rating,
      review_count: row.review_count,
      merchant_id: row.merchant_id,
      updated_at: row.updated_at,
    };
  }

  /**
   * Generate a human-readable match reason for search results.
   * 
   * @param {Object} row - Product row with score
   * @param {string[]} keywords - Search keywords
   * @returns {string} Match reason description
   * @private
   */
  _generateMatchReason(row, keywords) {
    const reasons = [];
    const name = (row.name || '').toLowerCase();
    const desc = (row.description || '').toLowerCase();
    const cat = (row.category || '').toLowerCase();
    const subcat = (row.subcategory || '').toLowerCase();

    for (const kw of keywords) {
      if (name.includes(kw)) reasons.push(`Name matches "${kw}"`);
      if (desc.includes(kw)) reasons.push(`Description matches "${kw}"`);
      if (cat.includes(kw)) reasons.push(`Category: ${row.category}`);
      if (subcat.includes(kw)) reasons.push(`Subcategory: ${row.subcategory}`);
    }

    const priceDisplay = `₹${(row.price_amount / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;
    reasons.push(`Price: ${priceDisplay}`);
    reasons.push(row.stock_available ? `In stock (${row.stock_quantity} units)` : 'Out of stock');
    if (row.rating) reasons.push(`Rating: ${row.rating}★`);

    return reasons.join(', ');
  }

  /**
   * Safely parse a JSON string, returning a fallback on failure.
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

module.exports = CatalogService;
