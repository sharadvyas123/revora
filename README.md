# 🛒 Agentic Commerce Gateway (ACG) v2

> **Bounded, Explainable, Gated, and Auditable Autonomous AI Commerce.**  
> Built for the Razorpay Agentic Commerce Hackathon 2026.

---

## 🌟 Overview

The **Agentic Commerce Gateway (ACG) v2** bridges autonomous AI Buyer Agents and financial infrastructure (Razorpay). It provides a cryptographically signed, 4-tier mandate model (**AP2 — Agent-Payment Protocol**) to solve the core risks of AI agents in commerce: **unbounded spending**, **hallucinated purchases**, **lack of human oversight**, and **untraceable actions**.

```
  Human Delegator ──▶ [Intent Mandate: Max ₹5,000] ──▶ AI Buyer Agent
                                                               │
                                                    Multi-Source Discovery
                                              (Local Catalog + External Web)
                                                               │
                                                   Recommendation Engine
                                              (AI Scoring + Comparison Matrix)
                                                               │
                                                 Coupon Validation (RUN500)
                                                               │
  Human Approval  ◀── [Cart Mandate: PENDING] ◄───────────────┘
        │
  ✅ Voice Confirmation Gate ("yes, proceed with purchase")
        │
  [Payment Mandate: AUTHORIZED] ──▶ Razorpay Payment Capture ──▶ Immutable Audit Log
```

---

## 🔑 Core Features & Safety Pillars (v2)

### 1. 🔐 Bounded Spending Mandates (AP2 Protocol)
- **Intent Mandate:** Human sets explicit spending limits, allowed categories, expiration TTL.
- **Cart Mandate:** AI Agent submits selected cart with natural language reasoning.
- **Payment Mandate:** Cryptographically signed JWT authorizing single-use Razorpay payment.

### 2. 🌐 Multi-Source Product Discovery (v2)
- `GET /api/v1/discovery/search` — Unified search across local merchant catalog **and** external web sources.
- Results normalized into a consistent product schema regardless of source.

### 3. 🤖 AI Recommendation & Comparison Engine (v2)
- `POST /api/v1/recommendations/decide` — Full pipeline: discover → score → rank → explain.
- `POST /api/v1/recommendations/compare` — Side-by-side matrix with composite scores, pros/cons, and badges (*Best Overall Match*, *Best Value*, *Highest Rated*).
- **Dual-Mode LLM:** Google Gemini 3.6 Flash (when `GEMINI_API_KEY` is set) or local deterministic scoring fallback.

### 4. 🏷️ Coupon & Voucher Management (v2)
- `GET /api/v1/coupons` — Discover active coupons for a merchant.
- `POST /api/v1/coupons/validate` — Validate a code, compute exact discount (read-only, does not consume).
- `POST /api/v1/coupons/apply` — Apply a coupon (increments usage counter at checkout).
- Mandate cap is checked against the **post-discount** final amount.

### 5. 🎙️ Voice Interaction Layer (v2)
- `POST /api/v1/voice/process` — STT → Agent → TTS pipeline.
- `POST /api/v1/voice/confirm-prompt` — Parses affirmative/negative voice response tokens.
- Web UI at `GET /voice` — Open in browser for real microphone & speaker demo.

### 6. 🛡️ Explicit Purchase Confirmation Gate (v2)
- `POST /api/v1/mandates/cart/confirm` — Records the human user's **explicit YES/NO** before payment executes.
- Gateway returns HTTP `403 CONFIRMATION_REQUIRED` if payment is attempted without prior confirmation.
- Supports VOICE, TEXT, and API channels with optional confirmation phrase logging.

### 7. 📜 Immutable 15-Step Audit Trail Engine
- SQLite append-only audit log with **database-level immutability** via SQL triggers.
- Full v2 step taxonomy: `REQUEST → PRODUCT_DISCOVERY → PRODUCT_RECOMMENDATION → PRODUCT_COMPARISON → COUPON_PROVIDED → COUPON_VALIDATED → DISCOUNT_APPLIED → MANDATE_CHECK → APPROVAL → PURCHASE_CONFIRMATION → PAYMENT → OUTCOME`.

---

## 🚀 Quickstart

### Prerequisites
- Node.js v18+
- SQLite3

### 1. Install Dependencies
```bash
npm install
```

### 2. Configure Environment Variables
Create a `.env` file:
```env
PORT=3000
NODE_ENV=development
DB_PATH=./data/acg.sqlite
JWT_SECRET=acg-hackathon-secret-key-2026

# Razorpay Test Credentials
RAZORPAY_KEY_ID=rzp_test_TTWqYy...
RAZORPAY_KEY_SECRET=secret_test_...

# Google Gemini LLM (Optional — activates AI reasoning when set)
GEMINI_API_KEY=your_gemini_api_key_here
GEMINI_MODEL=gemini-3.6-flash
```

### 3. Initialize & Seed Database
```bash
npm run reset-db
```
This drops and recreates the database, runs all migrations, and seeds merchant/agent/coupon data.

### 4. Start the Gateway Server
```bash
npm run dev
# Server runs on http://localhost:3000
```

---

## 🧪 Test Suites

| Test File | What It Covers | Expected |
|---|---|---|
| `test/test-integration.js` | v1 end-to-end mandate + payment flow | 34 tests |
| `test/test-recommendation.js` | comparison engine, decision scoring, decide pipeline | 20 tests |
| `test/test-coupon.js` | coupon validation, FLAT/%, expired, min-spend, usage limit | 31 tests |
| `test/test-voice.js` | STT modes, TTS formatting, voice confirmation tokens | 75 tests |
| `test/test-confirmation.js` | explicit confirmation gate, payment blocking, channels | 51 tests |
| `test/test-tools.js` | all 9 LLM function-calling tool schemas + integration | 160 tests |

### Run All Tests
```bash
node test/test-integration.js
node test/test-recommendation.js
node test/test-coupon.js
node test/test-voice.js
node test/test-confirmation.js
node test/test-tools.js
```

---

## 🎬 Demo Scenarios

### v2 Full Shopping Journey (Phase 15 — All v2 Features)
```bash
node demo/scenarios/v2-full-shopping-journey.js
```
Exercises every v2 subsystem in sequence:
- Multi-source discovery → recommendation → comparison → coupon validation → voice confirmation → payment

### v1 Scenarios

| Scenario | Command |
|---|---|
| Happy Path (Autonomous Bounded Purchase) | `node demo/scenarios/happy-path.js` |
| Spend Cap Violation (Safe Rejection) | `node demo/scenarios/spend-cap-exceeded.js` |
| Ambiguous Query (Zero Blind Spend) | `node demo/scenarios/ambiguous-match.js` |
| Payment Failure & Rollback | `node demo/scenarios/payment-declined.js` |

### Generate Audit Trail Report
```bash
node demo/report.js <audit_trail_id>
```

### Voice Studio Web UI
```
http://localhost:3000/voice
```
Open in a browser for a real microphone + speaker interactive demo.

---

## 📡 API Reference

### Public Endpoints
| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/health` | Gateway health check & DB row counts |
| `GET` | `/api/v1/catalog/products` | List all products |
| `GET` | `/api/v1/catalog/products/:id` | Get single product with variants |
| `GET` | `/api/v1/catalog/search?q=...` | Keyword search (local catalog only) |
| `GET` | `/api/v1/discovery/search?q=...` | **v2** Multi-source search (local + web) |
| `POST` | `/api/v1/recommendations/decide` | **v2** Full recommendation pipeline |
| `POST` | `/api/v1/recommendations/compare` | **v2** Side-by-side comparison matrix |
| `GET` | `/api/v1/coupons?merchant_id=...` | **v2** List active coupons |
| `POST` | `/api/v1/coupons/validate` | **v2** Validate coupon (read-only) |
| `POST` | `/api/v1/coupons/apply` | **v2** Apply coupon (consumes usage) |
| `POST` | `/api/v1/voice/process` | **v2** Voice STT → Agent → TTS pipeline |
| `GET` | `/voice` | **v2** Voice Studio Web UI |
| `GET` | `/api/v1/audit/transactions/:id` | Fetch immutable audit trail by transaction |

### Protected Endpoints (require `x-agent-id` header)
| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/v1/mandates/intent` | Create Intent Mandate (spending cap) |
| `POST` | `/api/v1/mandates/cart` | Submit Cart Mandate with AI reasoning |
| `POST` | `/api/v1/mandates/cart/:id/approve` | Human approval gate |
| `POST` | `/api/v1/mandates/cart/:id/reject` | Human rejection |
| `POST` | `/api/v1/mandates/cart/confirm` | **v2** Explicit purchase confirmation gate |
| `POST` | `/api/v1/payments/execute` | Execute Razorpay payment (requires confirmation) |
| `GET` | `/api/v1/payments/:id` | Get transaction status |

---

## 🏗️ Architecture

```
agent/
  agent.js              — BuyerAgent orchestrator (v1 flow)
  tools/
    index.js            — Central registry of all 9 LLM function-calling tools
    search-catalog.js   — GET /catalog/search
    search-web.js       — GET /discovery/search  (v2)
    get-product.js      — GET /catalog/products/:id
    compare-products.js — POST /recommendations/compare  (v2)
    find-coupons.js     — GET /coupons  (v2)
    validate-coupon.js  — POST /coupons/validate  (v2)
    create-cart.js      — POST /mandates/cart
    request-purchase-confirmation.js — POST /mandates/cart/confirm  (v2)
    execute-payment.js  — POST /payments/execute
  voice/
    stt.js              — Speech-to-Text engine  (v2)
    tts.js              — Text-to-Speech engine  (v2)
    voice-interface.js  — STT→Agent→TTS pipeline  (v2)

gateway/
  server.js             — Express app with all routes mounted
  routes/               — catalog, mandate, payment, audit, discovery, recommendation, coupon, voice
  services/             — business logic for each domain
  middleware/           — auth, validation, error handling

db/
  migrations/           — SQLite schema (001 initial, 002 v2 features, 003 coupon seed)
  reset.js              — Drop + recreate + seed

demo/
  scenarios/            — Runnable scenario scripts
```

---

*ACG v2 — Agentic Commerce Gateway | Razorpay Hackathon 2026*
