-- ============================================================
-- Agentic Commerce Gateway — v2 Coupon Seed Data
-- Database: SQLite 3.x
--
-- Inserts demo coupon records used by the Coupon & Voucher
-- Management System (Phase 11).
--
-- Safe to re-run (INSERT OR IGNORE).
-- Merchant reference: merch_sportshub from 001_initial.sql seed.
-- ============================================================

PRAGMA foreign_keys = OFF;

-- ── Demo Coupons ─────────────────────────────────────────────
-- All amounts in paise (₹1 = 100 paise)

-- RUN500: ₹500 flat discount for footwear orders ≥ ₹2,000
-- Test case: ₹4,299 product → ₹3,799 after coupon
INSERT OR IGNORE INTO coupons (
    coupon_id, merchant_id, code, discount_type,
    discount_value, min_order_amount, max_discount_amount,
    applicable_category, valid_from, valid_until,
    max_uses, times_used, status
) VALUES (
    'cpn_run500', 'merch_sportshub', 'RUN500', 'FLAT',
    50000, 200000, NULL,
    'footwear', datetime('now', '-30 days'), datetime('now', '+365 days'),
    1000, 0, 'ACTIVE'
);

-- SAVE10: 10% off any order ≥ ₹1,000, capped at ₹1,000 discount
INSERT OR IGNORE INTO coupons (
    coupon_id, merchant_id, code, discount_type,
    discount_value, min_order_amount, max_discount_amount,
    applicable_category, valid_from, valid_until,
    max_uses, times_used, status
) VALUES (
    'cpn_save10', 'merch_sportshub', 'SAVE10', 'PERCENTAGE',
    10, 100000, 100000,
    NULL, datetime('now', '-30 days'), datetime('now', '+365 days'),
    500, 0, 'ACTIVE'
);

-- WELCOME20: 20% off any order ≥ ₹500, capped at ₹500 discount
INSERT OR IGNORE INTO coupons (
    coupon_id, merchant_id, code, discount_type,
    discount_value, min_order_amount, max_discount_amount,
    applicable_category, valid_from, valid_until,
    max_uses, times_used, status
) VALUES (
    'cpn_welcome20', 'merch_sportshub', 'WELCOME20', 'PERCENTAGE',
    20, 50000, 50000,
    NULL, datetime('now', '-30 days'), datetime('now', '+365 days'),
    200, 0, 'ACTIVE'
);

-- EXPIRED100: ₹100 flat discount, expired 30 days ago (for testing validation failure)
INSERT OR IGNORE INTO coupons (
    coupon_id, merchant_id, code, discount_type,
    discount_value, min_order_amount, max_discount_amount,
    applicable_category, valid_from, valid_until,
    max_uses, times_used, status
) VALUES (
    'cpn_expired100', 'merch_sportshub', 'EXPIRED100', 'FLAT',
    10000, 0, NULL,
    NULL, datetime('now', '-60 days'), datetime('now', '-30 days'),
    NULL, 0, 'EXPIRED'
);

-- MAXED: Coupon that has hit its usage limit (for testing exhausted coupons)
INSERT OR IGNORE INTO coupons (
    coupon_id, merchant_id, code, discount_type,
    discount_value, min_order_amount, max_discount_amount,
    applicable_category, valid_from, valid_until,
    max_uses, times_used, status
) VALUES (
    'cpn_maxed', 'merch_sportshub', 'MAXED50', 'FLAT',
    5000, 0, NULL,
    NULL, datetime('now', '-30 days'), datetime('now', '+365 days'),
    10, 10, 'ACTIVE'
);
