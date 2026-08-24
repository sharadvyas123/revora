-- ============================================================
-- Agentic Commerce Gateway — Initial Schema
-- Database: SQLite 3.x
-- 
-- This migration creates all tables, indexes, and triggers
-- for the ACG data layer as specified in backend_schema.md.
-- ============================================================

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ============================================================
-- MERCHANTS
-- ============================================================
CREATE TABLE IF NOT EXISTS merchants (
    merchant_id     TEXT PRIMARY KEY,
    name            TEXT NOT NULL,
    rz_key_id       TEXT NOT NULL,           -- Razorpay test key ID
    rz_key_secret   TEXT NOT NULL,           -- Razorpay test key secret (encrypted in prod)
    webhook_url     TEXT,
    status          TEXT NOT NULL DEFAULT 'ACTIVE'
                    CHECK(status IN ('ACTIVE', 'INACTIVE', 'SUSPENDED')),
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ============================================================
-- PRODUCTS
-- ============================================================
CREATE TABLE IF NOT EXISTS products (
    product_id      TEXT PRIMARY KEY,
    merchant_id     TEXT NOT NULL REFERENCES merchants(merchant_id),
    name            TEXT NOT NULL,
    description     TEXT,
    category        TEXT NOT NULL,
    subcategory     TEXT,
    price_amount    INTEGER NOT NULL,        -- Amount in paise (₹1 = 100)
    price_currency  TEXT NOT NULL DEFAULT 'INR',
    stock_quantity  INTEGER NOT NULL DEFAULT 0,
    stock_available INTEGER NOT NULL DEFAULT 1  -- boolean: 0 or 1
                    CHECK(stock_available IN (0, 1)),
    low_stock_threshold INTEGER DEFAULT 5,
    policies        TEXT,                    -- JSON: {return_window_days, warranty_months, ...}
    media           TEXT,                    -- JSON: [{type, url, alt}]
    rating          REAL,                    -- Average rating (1.0 - 5.0)
    review_count    INTEGER DEFAULT 0,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_products_merchant ON products(merchant_id);
CREATE INDEX IF NOT EXISTS idx_products_category ON products(category);
CREATE INDEX IF NOT EXISTS idx_products_price ON products(price_amount);
CREATE INDEX IF NOT EXISTS idx_products_stock ON products(stock_available);

-- ============================================================
-- VARIANTS
-- ============================================================
CREATE TABLE IF NOT EXISTS variants (
    variant_id      TEXT PRIMARY KEY,
    product_id      TEXT NOT NULL REFERENCES products(product_id),
    attributes      TEXT NOT NULL,           -- JSON: {size, color, material, ...}
    price_override  INTEGER,                 -- Override price in paise (null = use product price)
    stock_quantity  INTEGER NOT NULL DEFAULT 0,
    stock_available INTEGER NOT NULL DEFAULT 1
                    CHECK(stock_available IN (0, 1)),
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_variants_product ON variants(product_id);

-- ============================================================
-- DELEGATORS (Human users who delegate to agents)
-- ============================================================
CREATE TABLE IF NOT EXISTS delegators (
    delegator_id    TEXT PRIMARY KEY,
    name            TEXT NOT NULL,
    email           TEXT,
    approval_webhook_url TEXT,               -- URL to send approval requests
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ============================================================
-- AGENTS (AI buyer agents)
-- ============================================================
CREATE TABLE IF NOT EXISTS agents (
    agent_id        TEXT PRIMARY KEY,
    name            TEXT NOT NULL,
    type            TEXT NOT NULL DEFAULT 'BUYER'
                    CHECK(type IN ('BUYER', 'SELLER', 'AUDITOR')),
    api_key         TEXT NOT NULL UNIQUE,     -- Agent authentication key
    api_secret      TEXT NOT NULL,            -- Agent authentication secret
    delegator_id    TEXT REFERENCES delegators(delegator_id),
    capabilities    TEXT,                    -- JSON: ["search", "purchase", "compare"]
    status          TEXT NOT NULL DEFAULT 'ACTIVE'
                    CHECK(status IN ('ACTIVE', 'INACTIVE', 'REVOKED')),
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_agents_api_key ON agents(api_key);

-- ============================================================
-- MANDATES (Intent → Cart → Payment chain)
-- ============================================================
CREATE TABLE IF NOT EXISTS mandates (
    mandate_id      TEXT PRIMARY KEY,
    type            TEXT NOT NULL
                    CHECK(type IN ('INTENT', 'CART', 'PAYMENT')),
    status          TEXT NOT NULL DEFAULT 'ACTIVE'
                    CHECK(status IN (
                        'ACTIVE',
                        'PENDING_APPROVAL',
                        'APPROVED',
                        'REJECTED',
                        'AUTHORIZED',
                        'EXPIRED',
                        'USED',
                        'CANCELLED'
                    )),
    parent_mandate_id TEXT REFERENCES mandates(mandate_id),  -- Chain reference
    delegator_id    TEXT NOT NULL REFERENCES delegators(delegator_id),
    agent_id        TEXT NOT NULL REFERENCES agents(agent_id),
    merchant_id     TEXT REFERENCES merchants(merchant_id),

    -- Constraints (JSON)
    constraints     TEXT NOT NULL,           -- JSON: {max_amount, currency, allowed_categories[], ...}

    -- Cart-specific fields (nullable for Intent mandates)
    items           TEXT,                    -- JSON: [{product_id, variant_id, quantity, unit_price}]
    reasoning       TEXT,                    -- JSON: {query, selected_product, reason, alternatives[]}

    -- Token
    token           TEXT NOT NULL,           -- Signed JWT token

    -- Timestamps
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at      TEXT NOT NULL,
    approved_at     TEXT,
    approved_by     TEXT,
    rejected_at     TEXT,
    rejected_by     TEXT,
    rejection_reason TEXT,
    used_at         TEXT
);

CREATE INDEX IF NOT EXISTS idx_mandates_type ON mandates(type);
CREATE INDEX IF NOT EXISTS idx_mandates_status ON mandates(status);
CREATE INDEX IF NOT EXISTS idx_mandates_delegator ON mandates(delegator_id);
CREATE INDEX IF NOT EXISTS idx_mandates_agent ON mandates(agent_id);
CREATE INDEX IF NOT EXISTS idx_mandates_parent ON mandates(parent_mandate_id);
CREATE INDEX IF NOT EXISTS idx_mandates_expires ON mandates(expires_at);

-- ============================================================
-- TRANSACTIONS
-- ============================================================
CREATE TABLE IF NOT EXISTS transactions (
    transaction_id      TEXT PRIMARY KEY,
    status              TEXT NOT NULL DEFAULT 'INITIATED'
                        CHECK(status IN (
                            'INITIATED',
                            'PAYMENT_PENDING',
                            'CAPTURED',
                            'FAILED',
                            'ROLLED_BACK'
                        )),

    -- Mandate chain
    intent_mandate_id   TEXT NOT NULL REFERENCES mandates(mandate_id),
    cart_mandate_id     TEXT NOT NULL REFERENCES mandates(mandate_id),
    payment_mandate_id  TEXT NOT NULL REFERENCES mandates(mandate_id),

    -- Parties
    agent_id            TEXT NOT NULL REFERENCES agents(agent_id),
    delegator_id        TEXT NOT NULL REFERENCES delegators(delegator_id),
    merchant_id         TEXT NOT NULL REFERENCES merchants(merchant_id),

    -- Order details
    items               TEXT NOT NULL,       -- JSON: [{product_id, variant_id, qty, price}]
    total_amount        INTEGER NOT NULL,    -- Total in paise
    currency            TEXT NOT NULL DEFAULT 'INR',

    -- Razorpay fields
    razorpay_order_id   TEXT,
    razorpay_payment_id TEXT,
    razorpay_signature  TEXT,

    -- Audit
    audit_trail_id      TEXT NOT NULL,

    -- Timestamps
    created_at          TEXT NOT NULL DEFAULT (datetime('now')),
    completed_at        TEXT,
    failure_reason      TEXT
);

CREATE INDEX IF NOT EXISTS idx_transactions_status ON transactions(status);
CREATE INDEX IF NOT EXISTS idx_transactions_agent ON transactions(agent_id);
CREATE INDEX IF NOT EXISTS idx_transactions_merchant ON transactions(merchant_id);
CREATE INDEX IF NOT EXISTS idx_transactions_delegator ON transactions(delegator_id);
CREATE INDEX IF NOT EXISTS idx_transactions_rz_order ON transactions(razorpay_order_id);

-- ============================================================
-- AUDIT ENTRIES (Append-only, immutable)
-- ============================================================
CREATE TABLE IF NOT EXISTS audit_entries (
    entry_id        TEXT PRIMARY KEY,
    audit_trail_id  TEXT NOT NULL,           -- Groups entries for one transaction
    step            TEXT NOT NULL
                    CHECK(step IN (
                        'REQUEST',
                        'DISCOVERY',
                        'DECISION',
                        'MANDATE_CHECK',
                        'APPROVAL',
                        'PAYMENT',
                        'OUTCOME',
                        'ERROR'
                    )),
    timestamp       TEXT NOT NULL DEFAULT (datetime('now')),
    data            TEXT NOT NULL,           -- JSON: step-specific payload
    
    -- Immutability marker
    immutable       INTEGER NOT NULL DEFAULT 1
                    CHECK(immutable = 1)
);

CREATE INDEX IF NOT EXISTS idx_audit_trail ON audit_entries(audit_trail_id);
CREATE INDEX IF NOT EXISTS idx_audit_step ON audit_entries(step);
CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_entries(timestamp);

-- ============================================================
-- TRIGGER: Prevent audit entry updates (immutability enforcement)
-- ============================================================
CREATE TRIGGER IF NOT EXISTS prevent_audit_update
    BEFORE UPDATE ON audit_entries
BEGIN
    SELECT RAISE(ABORT, 'Audit entries are immutable and cannot be updated');
END;

-- ============================================================
-- TRIGGER: Prevent audit entry deletion (immutability enforcement)
-- ============================================================
CREATE TRIGGER IF NOT EXISTS prevent_audit_delete
    BEFORE DELETE ON audit_entries
BEGIN
    SELECT RAISE(ABORT, 'Audit entries are immutable and cannot be deleted');
END;

-- ============================================================
-- TRIGGER: Auto-update products.updated_at on change
-- ============================================================
CREATE TRIGGER IF NOT EXISTS update_product_timestamp
    AFTER UPDATE ON products
BEGIN
    UPDATE products SET updated_at = datetime('now') WHERE product_id = NEW.product_id;
END;
