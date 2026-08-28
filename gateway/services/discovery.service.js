/**
 * @module gateway/services/discovery.service
 * @description Multi-Source Product Discovery Service for ACG v2.
 *
 * Orchestrates product discovery across two source types:
 *   1. LOCAL_CATALOG  — queries the merchant's own SQLite products table
 *      via the existing CatalogService keyword-search algorithm.
 *   2. EXTERNAL_WEB   — queries the external_products cache table and,
 *      when the cache is cold, calls the MockCrawler to generate
 *      representative external results.
 *
 * All candidates are normalized through NormalizerService into a
 * unified schema, then merged and ranked by a combined relevance score.
 *
 * The mock crawler simulates the behaviour of a real web crawler/
 * scraping pipeline so the full discovery flow can be exercised
 * locally without any external network calls.
 *
 * @see docs/TRD.md Section 3.4 — Discovery Pipeline
 * @see docs/ticket_01_multi_source_discovery.md Section 2.3
 */

const { v4: uuidv4 } = require('uuid');
const logger = require('../../lib/logger');
const NormalizerService = require('./normalizer.service');

// ── Mock Crawler Data ──────────────────────────────────────────────
// Simulates an external web-crawling pipeline. In production this
// would be replaced by an HTTP call to a scraping microservice or
// a shopping-API integration (Flipkart, Amazon, etc.).

const MOCK_EXTERNAL_CATALOG = [
  {
    source_name: 'Flipkart',
    source_url:  'https://www.flipkart.com/search?q=nike+pegasus',
    name:        'Nike Air Zoom Pegasus 41 (Flipkart)',
    description: 'Responsive foam with Zoom Air unit. Breathable mesh upper. Great for daily training runs.',
    category:    'footwear',
    subcategory: 'running_shoes',
    price:       { amount: 274900, currency: 'INR' },
    stock:       { available: true, quantity: 18 },
    rating:      4.3,
    review_count: 640,
    attributes:  { brand: 'Nike', gender: 'unisex' },
    tags:        ['nike', 'pegasus', 'running', 'footwear', 'shoes'],
  },
  {
    source_name: 'Flipkart',
    source_url:  'https://www.flipkart.com/search?q=adidas+ultraboost',
    name:        'Adidas Ultraboost 24',
    description: 'Energy-returning Boost midsole. Primeknit upper. Perfect for long-distance running.',
    category:    'footwear',
    subcategory: 'running_shoes',
    price:       { amount: 309900, currency: 'INR' },
    stock:       { available: true, quantity: 12 },
    rating:      4.6,
    review_count: 512,
    attributes:  { brand: 'Adidas', gender: 'unisex' },
    tags:        ['adidas', 'ultraboost', 'running', 'footwear', 'shoes'],
  },
  {
    source_name: 'Amazon India',
    source_url:  'https://www.amazon.in/s?k=asics+running+shoes',
    name:        'ASICS Gel-Nimbus 26',
    description: 'Maximum cushioning running shoe with GEL technology for long runs.',
    category:    'footwear',
    subcategory: 'running_shoes',
    price:       { amount: 239900, currency: 'INR' },
    stock:       { available: true, quantity: 30 },
    rating:      4.4,
    review_count: 830,
    attributes:  { brand: 'ASICS', gender: 'unisex' },
    tags:        ['asics', 'gel', 'nimbus', 'running', 'footwear', 'shoes'],
  },
  {
    source_name: 'Amazon India',
    source_url:  'https://www.amazon.in/s?k=skechers+running+shoes',
    name:        'Skechers GoRun Pulse 2.0',
    description: 'Lightweight comfort running shoe with Air-Cooled Memory Foam.',
    category:    'footwear',
    subcategory: 'running_shoes',
    price:       { amount: 89900, currency: 'INR' },
    stock:       { available: true, quantity: 55 },
    rating:      4.1,
    review_count: 2100,
    attributes:  { brand: 'Skechers', gender: 'unisex' },
    tags:        ['skechers', 'gorun', 'running', 'shoes', 'footwear'],
  },
  {
    source_name: 'Myntra',
    source_url:  'https://www.myntra.com/running-shoes',
    name:        'Puma Velocity NITRO 3',
    description: 'Nitrogen-infused NITRO foam midsole for an ultralight, springy ride.',
    category:    'footwear',
    subcategory: 'running_shoes',
    price:       { amount: 149900, currency: 'INR' },
    stock:       { available: true, quantity: 22 },
    rating:      4.2,
    review_count: 380,
    attributes:  { brand: 'Puma', gender: 'unisex' },
    tags:        ['puma', 'velocity', 'nitro', 'running', 'footwear', 'shoes'],
  },
  {
    source_name: 'Decathlon India',
    source_url:  'https://www.decathlon.in/c/running-shoes-17387',
    name:        'Kalenji Run Support Running Shoes',
    description: 'Entry-level running shoe with cushioned midsole. Ideal for beginners.',
    category:    'footwear',
    subcategory: 'running_shoes',
    price:       { amount: 59999, currency: 'INR' },
    stock:       { available: true, quantity: 100 },
    rating:      3.9,
    review_count: 3200,
    attributes:  { brand: 'Kalenji', gender: 'unisex' },
    tags:        ['kalenji', 'running', 'shoes', 'footwear', 'beginner'],
  },
  {
    source_name: 'Adidas Official',
    source_url:  'https://www.adidas.co.in/running-shoes',
    name:        'Adidas Samba OG',
    description: 'Iconic street-style sneaker with suede upper and gum outsole.',
    category:    'footwear',
    subcategory: 'casual_shoes',
    price:       { amount: 799900, currency: 'INR' },
    stock:       { available: true, quantity: 8 },
    rating:      4.7,
    review_count: 520,
    attributes:  { brand: 'Adidas', gender: 'unisex', style: 'casual' },
    tags:        ['adidas', 'samba', 'casual', 'sneaker', 'footwear', 'shoes'],
  },
  {
    source_name: 'Nike Official',
    source_url:  'https://www.nike.com/in/w/running-shoes-37i7z',
    name:        'Nike Dri-FIT ADV Training Tee',
    description: 'Sweat-wicking Dri-FIT fabric. Ventilation zones for hot training sessions.',
    category:    'apparel',
    subcategory: 'training_tops',
    price:       { amount: 399900, currency: 'INR' },
    stock:       { available: true, quantity: 35 },
    rating:      4.5,
    review_count: 290,
    attributes:  { brand: 'Nike', gender: 'unisex', material: 'polyester' },
    tags:        ['nike', 'dri-fit', 'training', 'apparel', 'tee', 'top'],
  },
];

// ── DiscoveryService ──────────────────────────────────────────────

class DiscoveryService {
  /**
   * @param {import('better-sqlite3').Database} db     - SQLite connection
   * @param {import('./catalog.service')} catalogService - v1 catalog service
   */
  constructor(db, catalogService) {
    this.db             = db;
    this.catalogService = catalogService;
    this.normalizer     = new NormalizerService();

    // Prepare reusable statements
    this._stmtGetCachedExternal = this.db.prepare(`
      SELECT * FROM external_products
      WHERE LOWER(query_keyword) = LOWER(?)
      ORDER BY fetched_at DESC
    `);

    this._stmtInsertExternal = this.db.prepare(`
      INSERT OR REPLACE INTO external_products
        (external_id, source_name, source_url, query_keyword, normalized_payload, fetched_at)
      VALUES (?, ?, ?, ?, ?, datetime('now'))
    `);
  }

  // ── Public API ─────────────────────────────────────────────────

  /**
   * Unified product discovery across local catalog and external sources.
   *
   * @param {Object} params
   * @param {string}  params.q          - Search query (required)
   * @param {number}  [params.max_price] - Maximum price filter in paise
   * @param {string}  [params.category]  - Category filter
   * @param {number}  [params.limit=10]  - Max results to return
   * @param {boolean} [params.local_only=false] - Skip external sources
   * @returns {Object} Discovery response with merged, ranked results
   */
  search({ q, max_price, category, limit = 10, local_only = false }) {
    logger.info('[DiscoveryService] search', { q, max_price, category, limit, local_only });

    const keywords = q.toLowerCase().split(/\s+/).filter(Boolean);

    // ── 1. Local Catalog Search ─────────────────────────────────
    const localResults = this._searchLocal({ q, max_price, category, limit: limit * 2 });

    // ── 2. External Products Search ─────────────────────────────
    let externalResults = [];
    if (!local_only) {
      externalResults = this._searchExternal({ q, keywords, max_price, category });
    }

    // ── 3. Merge & Rank ─────────────────────────────────────────
    const merged = this._mergeAndRank(localResults, externalResults, keywords, max_price, category);

    // ── 4. Slice to limit ────────────────────────────────────────
    const sliced = merged.slice(0, limit);

    logger.info('[DiscoveryService] search complete', {
      q,
      local_count:    localResults.length,
      external_count: externalResults.length,
      merged_count:   merged.length,
      returned:       sliced.length,
    });

    return {
      query:          q,
      filters:        { max_price: max_price ?? null, category: category ?? null },
      total_found:    merged.length,
      results:        sliced,
      sources_queried: local_only
        ? ['LOCAL_CATALOG']
        : ['LOCAL_CATALOG', 'EXTERNAL_WEB'],
    };
  }

  // ── Private: Local Search ──────────────────────────────────────

  /**
   * Run the existing CatalogService keyword search and normalize results.
   * @private
   */
  _searchLocal({ q, max_price, category, limit }) {
    try {
      const catalogResult = this.catalogService.search({ q, max_price, category, limit });
      return catalogResult.results.map(({ product, relevance_score }) => {
        // product is already formatted by CatalogService._formatProduct
        // We need the raw row to re-normalize — fetch it from DB
        const row = this.db.prepare(
          'SELECT * FROM products WHERE product_id = ?'
        ).get(product.product_id);

        if (!row) return null;

        const variants = this.db.prepare(
          'SELECT * FROM variants WHERE product_id = ?'
        ).all(product.product_id);

        const normalized = this.normalizer.normalizeLocal(row, variants);

        return {
          normalized,
          relevance_score,
          match_source: 'LOCAL_CATALOG',
        };
      }).filter(Boolean);
    } catch (err) {
      logger.warn('[DiscoveryService] Local search failed', { error: err.message });
      return [];
    }
  }

  // ── Private: External Search ───────────────────────────────────

  /**
   * Check the external_products cache; populate it from the mock
   * crawler if cold, then return normalized external candidates.
   * @private
   */
  _searchExternal({ q, keywords, max_price, category }) {
    // Try cache first
    const cached = this._stmtGetCachedExternal.all(q);
    if (cached.length > 0) {
      logger.debug('[DiscoveryService] external cache HIT', { q, count: cached.length });
      return cached.map((row) => ({
        normalized:    this.normalizer.normalizeExternal(row),
        relevance_score: this._scoreExternal(this.normalizer.normalizeExternal(row), keywords),
        match_source:  'EXTERNAL_WEB',
      }));
    }

    // Cache cold — run mock crawler
    logger.debug('[DiscoveryService] external cache MISS — running mock crawler', { q });
    const crawled = this._mockCrawl(keywords, max_price, category);

    // Persist to cache
    for (const item of crawled) {
      const externalId = `ext_${uuidv4().replace(/-/g, '').slice(0, 16)}`;
      this._stmtInsertExternal.run(
        externalId,
        item.source_name,
        item.source_url,
        q,
        JSON.stringify(item.normalized_payload),
      );
    }

    // Re-fetch from cache to get DB-assigned IDs and timestamps
    const freshCached = this._stmtGetCachedExternal.all(q);
    return freshCached.map((row) => ({
      normalized:     this.normalizer.normalizeExternal(row),
      relevance_score: this._scoreExternal(this.normalizer.normalizeExternal(row), keywords),
      match_source:   'EXTERNAL_WEB',
    }));
  }

  /**
   * Mock crawler: filter the in-memory MOCK_EXTERNAL_CATALOG by keyword
   * relevance and optional price/category filters.
   * Returns items ready to be persisted to external_products.
   * @private
   */
  _mockCrawl(keywords, max_price, category) {
    return MOCK_EXTERNAL_CATALOG
      .filter((item) => {
        // Category filter
        if (category && item.category !== category) return false;
        // Price filter
        if (max_price !== undefined && max_price !== null && item.price.amount > max_price) return false;
        // Keyword relevance: item must match at least one keyword in any field
        const haystack = [
          item.name,
          item.description,
          item.category,
          item.subcategory,
          ...(item.tags || []),
          ...(Object.values(item.attributes || {})),
        ].join(' ').toLowerCase();

        return keywords.some((kw) => haystack.includes(kw));
      })
      .map((item) => ({
        source_name:       item.source_name,
        source_url:        item.source_url,
        normalized_payload: {
          name:         item.name,
          description:  item.description,
          category:     item.category,
          subcategory:  item.subcategory,
          price:        item.price,
          stock:        item.stock,
          rating:       item.rating,
          review_count: item.review_count,
          attributes:   item.attributes,
          policies:     {},
          media:        [],
          merchant_id:  null,
          source_name:  item.source_name,
          source_url:   item.source_url,
        },
      }));
  }

  // ── Private: Scoring & Merging ────────────────────────────────

  /**
   * Score an already-normalized external product against keywords.
   * Returns a 0–1 float.
   * @private
   */
  _scoreExternal(normalized, keywords) {
    let score = 0;
    const fields = [
      { text: normalized.name,        weight: 10 },
      { text: normalized.description, weight: 5  },
      { text: normalized.category,    weight: 3  },
      { text: normalized.subcategory, weight: 3  },
    ];

    for (const kw of keywords) {
      for (const { text, weight } of fields) {
        if ((text || '').toLowerCase().includes(kw)) score += weight;
      }
    }

    const maxPossible = keywords.length * (10 + 5 + 3 + 3);
    return maxPossible > 0 ? Math.min(score / maxPossible, 1) : 0;
  }

  /**
   * Merge local and external candidate arrays, apply cross-source
   * deduplication by name similarity, apply filters, and sort.
   *
   * Final sort order: relevance_score DESC, rating DESC, price ASC.
   * @private
   */
  _mergeAndRank(localResults, externalResults, keywords, max_price, category) {
    const all = [...localResults, ...externalResults];

    // Apply filters to external results (local already filtered by CatalogService)
    const filtered = all.filter(({ normalized, match_source }) => {
      if (match_source === 'LOCAL_CATALOG') return true; // already filtered
      if (max_price !== undefined && max_price !== null && normalized.price.amount > max_price) return false;
      if (category && normalized.category !== category) return false;
      return true;
    });

    // Deduplicate by normalised name prefix (simple Jaccard heuristic)
    const seen = new Set();
    const deduped = filtered.filter(({ normalized }) => {
      const key = normalized.name.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 20);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    // Sort: relevance DESC, rating DESC, price ASC
    deduped.sort((a, b) => {
      if (b.relevance_score !== a.relevance_score) return b.relevance_score - a.relevance_score;
      const rA = a.normalized.rating ?? 0;
      const rB = b.normalized.rating ?? 0;
      if (rB !== rA) return rB - rA;
      return a.normalized.price.amount - b.normalized.price.amount;
    });

    return deduped.map(({ normalized, relevance_score, match_source }) => ({
      product:        normalized,
      relevance_score: Math.round(relevance_score * 100) / 100,
      match_source,
    }));
  }
}

module.exports = DiscoveryService;
