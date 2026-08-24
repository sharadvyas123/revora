/**
 * @module db/seed
 * @description Seeds the ACG database with demo data for one merchant, one delegator,
 * one agent, and ~8 products with variants.
 * 
 * Product catalog is deliberately designed for demo scenarios:
 * - Nike Pegasus (₹2,799) — happy path: within ₹3,000 cap
 * - Adidas Ultraboost (₹3,199) — spend cap exceeded scenario
 * - Puma Velocity (₹1,899) — lower-rated alternative
 * - ASICS Gel-Kayano (₹2,599) — good alternative
 * - NB FuelCell (₹2,499, OUT OF STOCK) — stock failure scenario
 * - Nike Dunk Low (casual, not running) — category filtering demo
 * - Nike Dri-FIT Tee (apparel) — category restriction demo
 * - Garmin Forerunner (₹49,999, electronics) — way over cap
 * 
 * @see docs/backend_schema.md Section 4 — Seed Data
 */

// ── Seed Data Definitions ───────────────────────────────────────────

const MERCHANT = {
  merchant_id: 'merch_sportshub',
  name: 'SportHub India',
  rz_key_id: 'rzp_test_xxxxxxxxxxxxx',     // Replace with real test key
  rz_key_secret: 'xxxxxxxxxxxxxxxxxxxxxxxx', // Replace with real test secret
  webhook_url: 'http://localhost:3000/api/v1/webhooks/razorpay',
  status: 'ACTIVE',
};

const DELEGATOR = {
  delegator_id: 'user_jane_doe',
  name: 'Jane Doe',
  email: 'jane@example.com',
  approval_webhook_url: 'http://localhost:3000/api/v1/approval/callback',
};

const AGENT = {
  agent_id: 'agent_shopper_01',
  name: 'ShopBot Alpha',
  type: 'BUYER',
  api_key: 'agent_key_test_001',
  api_secret: 'agent_secret_test_001',
  delegator_id: 'user_jane_doe',
  capabilities: JSON.stringify(['search', 'purchase', 'compare']),
  status: 'ACTIVE',
};

const PRODUCTS = [
  {
    product_id: 'prod_nike_pegasus',
    name: 'Nike Air Zoom Pegasus 41',
    description: 'Lightweight running shoe with responsive Zoom Air cushioning. Breathable mesh upper with secure fit.',
    category: 'footwear',
    subcategory: 'running_shoes',
    price_amount: 279900,     // ₹2,799
    stock_quantity: 42,
    rating: 4.5,
    review_count: 1280,
    policies: JSON.stringify({ return_window_days: 30, warranty_months: 6, cancellation_allowed: true }),
    media: JSON.stringify([{ type: 'image', url: 'https://example.com/nike-pegasus.jpg', alt: 'Nike Air Zoom Pegasus 41' }]),
    variants: [
      { variant_id: 'var_nike_peg_8_black', attributes: { size: '8', color: 'Black' }, stock_quantity: 12 },
      { variant_id: 'var_nike_peg_9_black', attributes: { size: '9', color: 'Black' }, stock_quantity: 10 },
      { variant_id: 'var_nike_peg_10_black', attributes: { size: '10', color: 'Black' }, stock_quantity: 8 },
      { variant_id: 'var_nike_peg_10_white', attributes: { size: '10', color: 'White' }, stock_quantity: 6 },
      { variant_id: 'var_nike_peg_11_black', attributes: { size: '11', color: 'Black' }, stock_quantity: 4 },
      { variant_id: 'var_nike_peg_12_black', attributes: { size: '12', color: 'Black' }, stock_quantity: 2 },
    ],
  },
  {
    product_id: 'prod_adidas_ultraboost',
    name: 'Adidas Ultraboost Light',
    description: 'Premium running shoe with BOOST midsole technology. Continental rubber outsole for superior grip.',
    category: 'footwear',
    subcategory: 'running_shoes',
    price_amount: 319900,     // ₹3,199 — deliberately over ₹3,000 for spend cap demo
    stock_quantity: 28,
    rating: 4.7,
    review_count: 950,
    policies: JSON.stringify({ return_window_days: 30, warranty_months: 12, cancellation_allowed: true }),
    media: JSON.stringify([{ type: 'image', url: 'https://example.com/adidas-ultraboost.jpg', alt: 'Adidas Ultraboost Light' }]),
    variants: [
      { variant_id: 'var_adi_ub_9_black', attributes: { size: '9', color: 'Core Black' }, stock_quantity: 8 },
      { variant_id: 'var_adi_ub_10_black', attributes: { size: '10', color: 'Core Black' }, stock_quantity: 10 },
      { variant_id: 'var_adi_ub_10_white', attributes: { size: '10', color: 'Cloud White' }, stock_quantity: 6 },
      { variant_id: 'var_adi_ub_11_black', attributes: { size: '11', color: 'Core Black' }, stock_quantity: 4 },
    ],
  },
  {
    product_id: 'prod_puma_velocity',
    name: 'Puma Velocity Nitro 3',
    description: 'Responsive running shoe with NITRO foam. Lightweight and durable for everyday training.',
    category: 'footwear',
    subcategory: 'running_shoes',
    price_amount: 189900,     // ₹1,899
    stock_quantity: 55,
    rating: 3.8,
    review_count: 420,
    policies: JSON.stringify({ return_window_days: 15, warranty_months: 6, cancellation_allowed: true }),
    media: JSON.stringify([{ type: 'image', url: 'https://example.com/puma-velocity.jpg', alt: 'Puma Velocity Nitro 3' }]),
    variants: [
      { variant_id: 'var_puma_vel_9_blue', attributes: { size: '9', color: 'Blue' }, stock_quantity: 15 },
      { variant_id: 'var_puma_vel_10_blue', attributes: { size: '10', color: 'Blue' }, stock_quantity: 20 },
      { variant_id: 'var_puma_vel_10_red', attributes: { size: '10', color: 'Red' }, stock_quantity: 10 },
      { variant_id: 'var_puma_vel_11_blue', attributes: { size: '11', color: 'Blue' }, stock_quantity: 10 },
    ],
  },
  {
    product_id: 'prod_asics_gel',
    name: 'ASICS Gel-Kayano 31',
    description: 'Stability running shoe with GEL technology cushioning. Ideal for overpronators seeking support.',
    category: 'footwear',
    subcategory: 'running_shoes',
    price_amount: 259900,     // ₹2,599
    stock_quantity: 18,
    rating: 4.6,
    review_count: 780,
    policies: JSON.stringify({ return_window_days: 30, warranty_months: 12, cancellation_allowed: true }),
    media: JSON.stringify([{ type: 'image', url: 'https://example.com/asics-gel.jpg', alt: 'ASICS Gel-Kayano 31' }]),
    variants: [
      { variant_id: 'var_asics_gel_10_grey', attributes: { size: '10', color: 'Sheet Rock' }, stock_quantity: 8 },
      { variant_id: 'var_asics_gel_10_blue', attributes: { size: '10', color: 'Blue Expanse' }, stock_quantity: 5 },
      { variant_id: 'var_asics_gel_11_grey', attributes: { size: '11', color: 'Sheet Rock' }, stock_quantity: 5 },
    ],
  },
  {
    product_id: 'prod_nb_fuelcell',
    name: 'New Balance FuelCell Rebel v4',
    description: 'Speed running shoe with FuelCell midsole. Ultra-light design for tempo runs and races.',
    category: 'footwear',
    subcategory: 'running_shoes',
    price_amount: 249900,     // ₹2,499
    stock_quantity: 0,         // OUT OF STOCK — for failure scenario demo
    rating: 4.4,
    review_count: 560,
    policies: JSON.stringify({ return_window_days: 30, warranty_months: 6, cancellation_allowed: false }),
    media: JSON.stringify([{ type: 'image', url: 'https://example.com/nb-fuelcell.jpg', alt: 'New Balance FuelCell Rebel v4' }]),
    variants: [
      { variant_id: 'var_nb_fuel_10_neon', attributes: { size: '10', color: 'Neon Green' }, stock_quantity: 0 },
    ],
  },
  {
    product_id: 'prod_nike_dunk',
    name: 'Nike Dunk Low Retro',
    description: 'Classic lifestyle sneaker with iconic design. Not a running shoe — casual streetwear style.',
    category: 'footwear',
    subcategory: 'casual_shoes',   // Different subcategory — for category filtering demo
    price_amount: 219900,     // ₹2,199
    stock_quantity: 35,
    rating: 4.3,
    review_count: 2100,
    policies: JSON.stringify({ return_window_days: 30, warranty_months: 3, cancellation_allowed: true }),
    media: JSON.stringify([{ type: 'image', url: 'https://example.com/nike-dunk.jpg', alt: 'Nike Dunk Low Retro' }]),
    variants: [
      { variant_id: 'var_nike_dunk_10_panda', attributes: { size: '10', color: 'Panda' }, stock_quantity: 15 },
      { variant_id: 'var_nike_dunk_10_grey', attributes: { size: '10', color: 'Grey Fog' }, stock_quantity: 10 },
    ],
  },
  {
    product_id: 'prod_dryfit_tee',
    name: 'Nike Dri-FIT Running T-Shirt',
    description: 'Moisture-wicking running tee with reflective details. Lightweight and breathable fabric.',
    category: 'apparel',
    subcategory: 'running_tops',   // Different category — for category restriction demo
    price_amount: 149900,     // ₹1,499
    stock_quantity: 100,
    rating: 4.2,
    review_count: 890,
    policies: JSON.stringify({ return_window_days: 15, warranty_months: 0, cancellation_allowed: true }),
    media: JSON.stringify([{ type: 'image', url: 'https://example.com/dryfit-tee.jpg', alt: 'Nike Dri-FIT Running T-Shirt' }]),
    variants: [
      { variant_id: 'var_dryfit_m_black', attributes: { size: 'M', color: 'Black' }, stock_quantity: 30 },
      { variant_id: 'var_dryfit_l_black', attributes: { size: 'L', color: 'Black' }, stock_quantity: 25 },
    ],
  },
  {
    product_id: 'prod_garmin_watch',
    name: 'Garmin Forerunner 265',
    description: 'GPS running watch with AMOLED display. Advanced training metrics and recovery insights.',
    category: 'electronics',
    subcategory: 'smartwatches',   // Different category — for category restriction demo
    price_amount: 4999900,    // ₹49,999 — way over typical cap
    stock_quantity: 12,
    rating: 4.8,
    review_count: 340,
    policies: JSON.stringify({ return_window_days: 7, warranty_months: 24, cancellation_allowed: false }),
    media: JSON.stringify([{ type: 'image', url: 'https://example.com/garmin-forerunner.jpg', alt: 'Garmin Forerunner 265' }]),
    variants: [
      { variant_id: 'var_garmin_black', attributes: { color: 'Black' }, stock_quantity: 5 },
      { variant_id: 'var_garmin_white', attributes: { color: 'Whitestone' }, stock_quantity: 3 },
    ],
  },
];

// ── Seed Function ───────────────────────────────────────────────────

/**
 * Seed the database with demo data.
 * Inserts merchant, delegator, agent, products, and variants.
 * 
 * @param {import('better-sqlite3').Database} db - The better-sqlite3 database instance.
 */
function seed(db) {
  console.log('\n📦 Seeding demo data...\n');

  // ── Insert Merchant ─────────────────────────────────────────────
  const insertMerchant = db.prepare(`
    INSERT OR REPLACE INTO merchants (merchant_id, name, rz_key_id, rz_key_secret, webhook_url, status)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  insertMerchant.run(
    MERCHANT.merchant_id,
    MERCHANT.name,
    MERCHANT.rz_key_id,
    MERCHANT.rz_key_secret,
    MERCHANT.webhook_url,
    MERCHANT.status
  );
  console.log(`  ✓ Merchant: ${MERCHANT.name} (${MERCHANT.merchant_id})`);

  // ── Insert Delegator ────────────────────────────────────────────
  const insertDelegator = db.prepare(`
    INSERT OR REPLACE INTO delegators (delegator_id, name, email, approval_webhook_url)
    VALUES (?, ?, ?, ?)
  `);
  insertDelegator.run(
    DELEGATOR.delegator_id,
    DELEGATOR.name,
    DELEGATOR.email,
    DELEGATOR.approval_webhook_url
  );
  console.log(`  ✓ Delegator: ${DELEGATOR.name} (${DELEGATOR.delegator_id})`);

  // ── Insert Agent ────────────────────────────────────────────────
  const insertAgent = db.prepare(`
    INSERT OR REPLACE INTO agents (agent_id, name, type, api_key, api_secret, delegator_id, capabilities, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insertAgent.run(
    AGENT.agent_id,
    AGENT.name,
    AGENT.type,
    AGENT.api_key,
    AGENT.api_secret,
    AGENT.delegator_id,
    AGENT.capabilities,
    AGENT.status
  );
  console.log(`  ✓ Agent: ${AGENT.name} (${AGENT.agent_id})`);

  // ── Insert Products + Variants ──────────────────────────────────
  const insertProduct = db.prepare(`
    INSERT OR REPLACE INTO products (
      product_id, merchant_id, name, description, category, subcategory,
      price_amount, price_currency, stock_quantity, stock_available,
      policies, media, rating, review_count
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'INR', ?, ?, ?, ?, ?, ?)
  `);

  const insertVariant = db.prepare(`
    INSERT OR REPLACE INTO variants (
      variant_id, product_id, attributes, price_override, stock_quantity, stock_available
    ) VALUES (?, ?, ?, ?, ?, ?)
  `);

  // Use a transaction for atomicity
  const seedProducts = db.transaction(() => {
    for (const product of PRODUCTS) {
      const stockAvailable = product.stock_quantity > 0 ? 1 : 0;

      insertProduct.run(
        product.product_id,
        MERCHANT.merchant_id,
        product.name,
        product.description,
        product.category,
        product.subcategory,
        product.price_amount,
        product.stock_quantity,
        stockAvailable,
        product.policies,
        product.media || null,
        product.rating,
        product.review_count
      );

      // Insert variants for this product
      for (const variant of product.variants) {
        const variantStockAvailable = variant.stock_quantity > 0 ? 1 : 0;

        insertVariant.run(
          variant.variant_id,
          product.product_id,
          JSON.stringify(variant.attributes),
          variant.price_override || null,
          variant.stock_quantity,
          variantStockAvailable
        );
      }

      const priceDisplay = `₹${(product.price_amount / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;
      const stockLabel = stockAvailable ? `${product.stock_quantity} in stock` : 'OUT OF STOCK';
      console.log(`  ✓ Product: ${product.name} — ${priceDisplay} (${stockLabel}, ${product.variants.length} variants)`);
    }
  });

  seedProducts();

  // ── Summary ─────────────────────────────────────────────────────
  const counts = {
    merchants: db.prepare('SELECT COUNT(*) as count FROM merchants').get().count,
    products: db.prepare('SELECT COUNT(*) as count FROM products').get().count,
    variants: db.prepare('SELECT COUNT(*) as count FROM variants').get().count,
    delegators: db.prepare('SELECT COUNT(*) as count FROM delegators').get().count,
    agents: db.prepare('SELECT COUNT(*) as count FROM agents').get().count,
  };

  console.log('\n  ────────────────────────────────────');
  console.log(`  📊 Seeded: ${counts.merchants} merchant, ${counts.products} products, ${counts.variants} variants`);
  console.log(`           ${counts.delegators} delegator, ${counts.agents} agent`);
  console.log('  ────────────────────────────────────\n');
}

module.exports = { seed, MERCHANT, DELEGATOR, AGENT, PRODUCTS };
