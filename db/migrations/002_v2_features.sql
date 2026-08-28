-- ============================================================
-- Agentic Commerce Gateway — v2 Feature Migration
-- Database: SQLite 3.x
--
-- All changes are ADDITIVE — no tables, columns, or triggers
-- from 001_initial.sql are dropped or modified.
-- Safe to re-run (uses IF NOT EXISTS / ADD COLUMN patterns).
-- ============================================================

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ============================================================
-- EXTERNAL PRODUCTS CACHE
-- Stores normalized product data fetched from external sources
-- (web crawlers, partner APIs, third-party marketplaces).
-- ============================================================
CREATE TABLE IF NOT EXISTS external_products (
    external_id         TEXT PRIMARY KEY,
    source_name         TEXT NOT NULL,          -- e.g. "Google Shopping", "Flipkart", "Mock Crawler"
    source_url          TEXT NOT NULL,          -- Original source URL
    query_keyword       TEXT NOT NULL,          -- Search query that produced this result
    normalized_payload  TEXT NOT NULL,          -- JSON: Normalized Product Schema (see TRD 3.4)
    fetched_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_external_query    ON external_products(query_keyword);
CREATE INDEX IF NOT EXISTS idx_external_source   ON external_products(source_name);
CREATE INDEX IF NOT EXISTS idx_external_fetched  ON external_products(fetched_at);

-- ============================================================
-- COUPONS
-- Merchant-issued discount codes validated at checkout.
-- ============================================================
CREATE TABLE IF NOT EXISTS coupons (
    coupon_id           TEXT PRIMARY KEY,
    merchant_id         TEXT NOT NULL REFERENCES merchants(merchant_id),
    code                TEXT NOT NULL,          -- Human-readable coupon code (e.g. "SAVE10")
    discount_type       TEXT NOT NULL           -- "PERCENTAGE" or "FLAT"
                        CHECK(discount_type IN ('PERCENTAGE', 'FLAT')),
    discount_value      INTEGER NOT NULL,       -- Percentage (0-100) or flat amount in paise
    min_order_amount    INTEGER DEFAULT 0,      -- Minimum cart value in paise to apply
    max_discount_amount INTEGER,               -- Cap for percentage discounts (paise, null = unlimited)
    applicable_category TEXT,                  -- NULL means any category
    valid_from          TEXT NOT NULL DEFAULT (datetime('now')),
    valid_until         TEXT,                  -- NULL means no expiry
    max_uses            INTEGER,               -- NULL means unlimited
    times_used          INTEGER NOT NULL DEFAULT 0,
    status              TEXT NOT NULL DEFAULT 'ACTIVE'
                        CHECK(status IN ('ACTIVE', 'INACTIVE', 'EXPIRED')),
    created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_coupons_code    ON coupons(merchant_id, code);
CREATE INDEX IF NOT EXISTS idx_coupons_status         ON coupons(status);
CREATE INDEX IF NOT EXISTS idx_coupons_merchant       ON coupons(merchant_id);

-- ============================================================
-- ADDITIVE COLUMNS: mandates (v2 coupon + channel support)
-- SQLite supports ADD COLUMN but not IF NOT EXISTS guard.
-- DatabaseManager swallows "duplicate column" errors gracefully.
-- ============================================================

ALTER TABLE mandates ADD COLUMN coupon_code         TEXT;
ALTER TABLE mandates ADD COLUMN original_amount     INTEGER;
ALTER TABLE mandates ADD COLUMN discount_amount     INTEGER DEFAULT 0;
ALTER TABLE mandates ADD COLUMN final_amount        INTEGER;
ALTER TABLE mandates ADD COLUMN confirmation_status TEXT DEFAULT 'PENDING';
ALTER TABLE mandates ADD COLUMN channel             TEXT DEFAULT 'TEXT';

-- ============================================================
-- ADDITIVE COLUMNS: transactions (v2 coupon + channel support)
-- ============================================================

ALTER TABLE transactions ADD COLUMN coupon_code         TEXT;
ALTER TABLE transactions ADD COLUMN original_amount     INTEGER;
ALTER TABLE transactions ADD COLUMN discount_amount     INTEGER DEFAULT 0;
ALTER TABLE transactions ADD COLUMN final_amount        INTEGER;
ALTER TABLE transactions ADD COLUMN confirmation_status TEXT DEFAULT 'PENDING';
ALTER TABLE transactions ADD COLUMN channel             TEXT DEFAULT 'TEXT';

-- ============================================================
-- NOTE: audit_entries CHECK constraint for `step` cannot be
-- altered in SQLite without table recreation. The v2 pipeline
-- maps new logical steps (PRODUCT_DISCOVERY, COUPON_VALIDATED,
-- etc.) onto the existing CHECK-valid values at the service
-- layer. No DDL change is needed here.
-- See: gateway/services/audit.service.js step mapping.
-- ============================================================
