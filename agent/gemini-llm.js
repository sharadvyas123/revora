/**
 * @module agent/gemini-llm
 * @description Google Gemini LLM integration for the AI Buyer Agent Simulator.
 *
 * Provides three AI-powered capabilities using @google/generative-ai:
 *
 *   1. parseIntentWithGemini(prompt)
 *      → Uses Gemini to extract structured purchase intent from natural language.
 *        Returns: { keywords, category, max_price, quantity, currency }
 *
 *   2. decideWithGemini(searchResults, intent)
 *      → Uses Gemini to reason across catalog candidates, select the best product,
 *        and generate a natural language explanation + alternatives list.
 *
 *   3. isAvailable()
 *      → Returns true if GEMINI_API_KEY is configured and the model is ready.
 *
 * Designed for dual-mode operation:
 *   - When GEMINI_API_KEY is in .env → real Gemini LLM reasoning
 *   - When key is absent → caller should fall back to local NLU engine
 *
 * @see https://ai.google.dev/api/generate-content
 */

require('dotenv').config();
const { GoogleGenerativeAI, SchemaType } = require('@google/generative-ai');

// ── Lazy-init Gemini Client ─────────────────────────────────────────

let _client = null;
let _model = null;

/**
 * Returns true if GEMINI_API_KEY is set and the SDK can be initialized.
 */
function isAvailable() {
  return !!(process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY.trim().length > 0);
}

/**
 * Get (or lazily initialize) the Gemini GenerativeModel instance.
 * @returns {import('@google/generative-ai').GenerativeModel}
 */
function getModel() {
  if (_model) return _model;

  if (!isAvailable()) {
    throw new Error('GEMINI_API_KEY is not set. Cannot use Gemini LLM.');
  }

  _client = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  const modelName = process.env.GEMINI_MODEL || 'gemini-3.6-flash';
  _model = _client.getGenerativeModel({ model: modelName });
  return _model;
}

// ════════════════════════════════════════════════════════════════════
//  1. INTENT PARSER — Gemini extracts structured intent from prompt
// ════════════════════════════════════════════════════════════════════

/**
 * Parse a natural language purchase prompt into structured intent using Gemini.
 *
 * @param {string} prompt - Human's raw instruction (e.g. "buy running shoes under ₹3000")
 * @returns {Promise<Object>} Parsed intent:
 *   { keywords: string[], category: string|null, max_price: number|null,
 *     currency: string, quantity: number, gemini_reasoning: string }
 */
async function parseIntentWithGemini(prompt) {
  const model = getModel();

  const systemInstruction = `You are an AI purchase intent extractor for an agentic commerce system.
Extract structured purchase intent from the user's natural language instruction.

You MUST return a valid JSON object with these exact fields:
- keywords: array of significant search keywords (remove stopwords like buy/get/find/a/the)
- category: one of "footwear", "apparel", "electronics", or null if unclear
- max_price: maximum budget in PAISE (₹1 = 100 paise, so ₹3000 = 300000). null if no budget mentioned.
- currency: always "INR"
- quantity: number of items (integer, default 1)
- reasoning: 1-2 sentence explanation of your extraction

Examples:
- "buy running shoes under 3000 rupees" → {"keywords":["running","shoes"],"category":"footwear","max_price":300000,"currency":"INR","quantity":1,"reasoning":"User wants running shoes with a ₹3,000 budget."}
- "find me 2 pairs of sneakers below ₹2500" → {"keywords":["sneakers"],"category":"footwear","max_price":250000,"currency":"INR","quantity":2,"reasoning":"User wants 2 pairs of sneakers within ₹2,500 budget."}
- "get a dri-fit shirt under 1500" → {"keywords":["dri-fit","shirt"],"category":"apparel","max_price":150000,"currency":"INR","quantity":1,"reasoning":"User wants a Dri-FIT shirt under ₹1,500."}`;

  const result = await model.generateContent({
    contents: [
      {
        role: 'user',
        parts: [{ text: `Extract purchase intent from: "${prompt}"` }],
      },
    ],
    systemInstruction,
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: {
        type: SchemaType.OBJECT,
        properties: {
          keywords:  { type: SchemaType.ARRAY,   items: { type: SchemaType.STRING } },
          category:  { type: SchemaType.STRING  },
          max_price: { type: SchemaType.NUMBER  },
          currency:  { type: SchemaType.STRING  },
          quantity:  { type: SchemaType.NUMBER  },
          reasoning: { type: SchemaType.STRING  },
        },
        required: ['keywords', 'currency', 'quantity', 'reasoning'],
      },
    },
  });

  const text = result.response.text();
  const parsed = JSON.parse(text);

  return {
    keywords:         Array.isArray(parsed.keywords) ? parsed.keywords : [],
    category:         parsed.category || null,
    max_price:        parsed.max_price ? Math.round(parsed.max_price) : null,
    currency:         parsed.currency || 'INR',
    quantity:         parsed.quantity || 1,
    raw_prompt:       prompt,
    gemini_reasoning: parsed.reasoning || '',
  };
}

// ════════════════════════════════════════════════════════════════════
//  2. DECISION ENGINE — Gemini reasons over candidates, picks winner
// ════════════════════════════════════════════════════════════════════

/**
 * Use Gemini to evaluate product search results and select the best match.
 *
 * @param {Object[]} searchResults - Array of { product, relevance_score, match_reason }
 * @param {Object} intent - Parsed purchase intent
 * @returns {Promise<Object>} Decision result:
 *   { selected: { product_id, name, price, variant_id, reason },
 *     alternatives: [...], reasoning: string, filters_applied: {...} }
 */
async function decideWithGemini(searchResults, intent) {
  const model = getModel();

  if (!searchResults || searchResults.length === 0) {
    return {
      selected: null,
      alternatives: [],
      filters_applied: buildFiltersApplied(intent),
      reasoning: 'No products were found matching the search criteria.',
    };
  }

  // Build a concise product summary for Gemini to reason over
  const productList = searchResults.map((r, i) => ({
    index: i + 1,
    product_id: r.product.product_id,
    name: r.product.name,
    description: r.product.description,
    category: r.product.category,
    subcategory: r.product.subcategory,
    price_rupees: r.product.price.amount / 100,
    price_display: r.product.price.display,
    price_paise: r.product.price.amount,
    rating: r.product.rating,
    review_count: r.product.review_count,
    stock_quantity: r.product.stock.quantity,
    in_stock: r.product.stock.available,
    relevance_score: r.relevance_score,
    variants_available: r.product.variants
      ? r.product.variants.filter(v => v.stock.available).length
      : 0,
    best_variant_id: getBestVariant(r.product),
  })).filter(p => p.in_stock); // only in-stock items

  if (productList.length === 0) {
    return {
      selected: null,
      alternatives: [],
      filters_applied: buildFiltersApplied(intent),
      reasoning: 'All found products are out of stock.',
    };
  }

  const budgetRupees = intent.max_price ? intent.max_price / 100 : null;
  const withinBudget = budgetRupees
    ? productList.filter(p => p.price_rupees <= budgetRupees)
    : productList;

  if (withinBudget.length === 0) {
    const cheapest = [...productList].sort((a, b) => a.price_rupees - b.price_rupees)[0];
    return {
      selected: null,
      alternatives: productList.map(p => ({
        product_id: p.product_id,
        name: p.name,
        price: { amount: p.price_paise, display: p.price_display },
        reason: `Exceeds budget (${p.price_display} > ₹${budgetRupees?.toLocaleString('en-IN')})`,
      })),
      filters_applied: buildFiltersApplied(intent),
      reasoning: `All ${productList.length} in-stock results exceed the ₹${budgetRupees?.toLocaleString('en-IN')} budget. Cheapest option: ${cheapest.name} at ${cheapest.price_display}.`,
    };
  }

  const systemInstruction = `You are an AI shopping assistant for an agentic commerce system. 
Your job is to evaluate a list of products and select the BEST ONE for the user based on their purchase intent.

Consider these factors in order of priority:
1. Budget compliance — never select a product that exceeds the budget
2. Relevance — how well the product matches what the user asked for
3. Rating and reviews — higher rated, more reviewed products are more trustworthy
4. Value for money — better quality per rupee spent
5. Stock availability — prefer items with more stock

Return a JSON object with:
- selected_product_id: the product_id of the best choice
- selected_variant_id: the best variant_id (or null)
- selection_reason: 2-3 sentence natural language explanation of WHY this product is best
- alternatives: array of {product_id, reason_not_selected} for all OTHER products
- overall_reasoning: 1 paragraph explaining the full decision process`;

  const userPrompt = `User's purchase request: "${intent.raw_prompt}"
Budget constraint: ${budgetRupees ? `₹${budgetRupees.toLocaleString('en-IN')} (${intent.max_price} paise)` : 'No budget limit'}
Product category preference: ${intent.category || 'Any'}

Available products to evaluate:
${JSON.stringify(withinBudget, null, 2)}

Select the BEST product for this user. Return JSON.`;

  const result = await model.generateContent({
    contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
    systemInstruction,
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: {
        type: SchemaType.OBJECT,
        properties: {
          selected_product_id: { type: SchemaType.STRING },
          selected_variant_id:  { type: SchemaType.STRING },
          selection_reason:     { type: SchemaType.STRING },
          alternatives: {
            type: SchemaType.ARRAY,
            items: {
              type: SchemaType.OBJECT,
              properties: {
                product_id:          { type: SchemaType.STRING },
                reason_not_selected: { type: SchemaType.STRING },
              },
            },
          },
          overall_reasoning: { type: SchemaType.STRING },
        },
        required: ['selected_product_id', 'selection_reason', 'overall_reasoning'],
      },
    },
  });

  const text = result.response.text();
  const geminiDecision = JSON.parse(text);

  // Resolve the selected product back to full product data
  const selectedEntry = searchResults.find(
    r => r.product.product_id === geminiDecision.selected_product_id
  );

  if (!selectedEntry) {
    // Gemini returned a product ID not in the list — fall back to top candidate
    const fallback = searchResults.find(r => withinBudget.some(p => p.product_id === r.product.product_id));
    if (!fallback) {
      return { selected: null, alternatives: [], filters_applied: buildFiltersApplied(intent), reasoning: 'Gemini selection could not be resolved.' };
    }
    return buildResult(fallback, searchResults, geminiDecision, intent);
  }

  return buildResult(selectedEntry, searchResults, geminiDecision, intent);
}

// ── Helpers ─────────────────────────────────────────────────────────

function buildResult(selectedEntry, allResults, geminiDecision, intent) {
  const product = selectedEntry.product;

  const alternatives = (geminiDecision.alternatives || []).map(alt => {
    const altEntry = allResults.find(r => r.product.product_id === alt.product_id);
    return {
      product_id:  alt.product_id,
      name:        altEntry?.product.name || alt.product_id,
      price:       altEntry?.product.price || {},
      reason:      alt.reason_not_selected || 'Not selected by AI',
    };
  });

  return {
    selected: {
      product_id:      product.product_id,
      name:            product.name,
      price:           product.price,
      variant_id:      geminiDecision.selected_variant_id || getBestVariant(product),
      composite_score: selectedEntry.relevance_score,
      reason:          geminiDecision.selection_reason,
    },
    alternatives,
    filters_applied: buildFiltersApplied(intent),
    reasoning:       geminiDecision.overall_reasoning || geminiDecision.selection_reason,
    gemini_powered:  true,
  };
}

function getBestVariant(product) {
  if (!product.variants || product.variants.length === 0) return null;
  const available = product.variants
    .filter(v => v.stock && v.stock.available && v.stock.quantity > 0)
    .sort((a, b) => b.stock.quantity - a.stock.quantity);
  return available.length > 0 ? available[0].variant_id : product.variants[0].variant_id;
}

function buildFiltersApplied(intent) {
  return {
    budget:       intent.max_price ? `₹${(intent.max_price / 100).toLocaleString('en-IN')}` : 'none',
    budget_paise: intent.max_price,
    category:     intent.category || 'any',
    keywords:     intent.keywords,
    raw_prompt:   intent.raw_prompt,
  };
}

module.exports = { isAvailable, parseIntentWithGemini, decideWithGemini, getModel };
