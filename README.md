# 🛒 Agentic Commerce Gateway (ACG)

> **Bounded, Explainable, Gated, and Auditable Autonomous AI Commerce.**  
> Built for the Razorpay Agentic Commerce Hackathon 2026.

---

## 🌟 Overview

The **Agentic Commerce Gateway (ACG)** bridges autonomous AI Buyer Agents and financial infrastructure (Razorpay). It provides a cryptographically signed, 4-tier mandate model (**AP2 — Agent-Payment Protocol**) to solve the core risks of AI agents in commerce: **unbounded spending**, **hallucinated purchases**, **lack of human oversight**, and **untraceable actions**.

```
 Human Delegator ──▶ [Intent Mandate: Max ₹3,000] ──▶ AI Buyer Agent
                                                              │
                                                      ACP Catalog Search
                                                              │
                                                    [Gemini 3.6 AI Reasoning]
                                                              │
 Human Approval  ◀── [Cart Mandate: PENDING] ◄────────────────┘
       │
 [Payment Mandate: AUTHORIZED] ──▶ Razorpay Payment Capture ──▶ Immutable Audit Log
```

---

## 🔑 Core Features & Safety Pillars

1. **🔐 Bounded Spending Mandates (AP2 Protocol)**
   - **Intent Mandate:** Human sets explicit spending limits, allowed categories, and expiration TTL.
   - **Cart Mandate:** AI Agent submits selected cart items with natural language reasoning and rejected alternatives.
   - **Payment Mandate:** Cryptographically signed JWT token authorizing single-use Razorpay payment execution.

2. **🤖 AI Reasoning Engine (Dual-Mode)**
   - **Google Gemini 3.6 Flash:** Holistic natural language intent extraction and multi-product evaluation. Gemini explicitly explains *why* a product was chosen and *why* alternatives were rejected (e.g. recognizing casual lifestyle sneakers vs athletic running shoes).
   - **Local NLU & Scoring Fallback:** Zero-latency deterministic engine for offline execution when API key is unconfigured.

3. **🛡️ Human Approval Gate**
   - No payment can move without explicit delegator authorization (`POST /mandates/cart/:id/approve`).

4. **📜 Immutable Audit Trail Engine**
   - SQLite append-only audit log.
   - **Database-Level Immutability:** Enforced via SQL triggers (`BEFORE UPDATE` / `BEFORE DELETE`) blocking tampering or entry deletion.

---

## 🚀 Quickstart & Installation

### Prerequisites
- Node.js v18+
- SQLite3

### 1. Installation
```bash
npm install
```

### 2. Configure Environment Variables
Create a `.env` file (or copy `.env.example`):
```env
PORT=3000
NODE_ENV=development
DB_PATH=./data/acg.sqlite
JWT_SECRET=acg-hackathon-secret-key-2026

# Razorpay Test Credentials (or use built-in simulation mode)
RAZORPAY_KEY_ID=rzp_test_TTWqYy...
RAZORPAY_KEY_SECRET=secret_test_...

# Google Gemini LLM (Optional — uses Gemini 3.6 Flash when set)
GEMINI_API_KEY=your_gemini_api_key_here
GEMINI_MODEL=gemini-3.6-flash
```

### 3. Initialize & Seed Database
```bash
node db/reset.js
```

### 4. Start the Gateway Server
```bash
npm run dev
# Server runs on http://localhost:3000
```

---

## 🧪 Testing & Demonstration

### Run Integration Test Suite (34 Tests)
```bash
node test/test-integration.js
```

### Run Master Demo Suite (4 Scenarios)
```bash
npm run demo
```

#### Individual Scenarios:
- **Scenario 1: Bounded Purchase (Happy Path)**
  ```bash
  node demo/scenarios/happy-path.js
  ```
- **Scenario 2: Spend Cap Violation (Safe Rejection)**
  ```bash
  node demo/scenarios/spend-cap-exceeded.js
  ```
- **Scenario 3: Ambiguous Query (Zero Blind Spend)**
  ```bash
  node demo/scenarios/ambiguous-match.js
  ```
- **Scenario 4: Payment Failure & Rollback**
  ```bash
  node demo/scenarios/payment-declined.js
  ```

### Generate Visual Audit Trail Report
```bash
node demo/report.js <audit_trail_id>
```

---

## 📡 API Reference

| Method | Endpoint | Description | Auth Required |
|--------|----------|-------------|---------------|
| `GET` | `/health` | Gateway health check & DB counts | Public |
| `GET` | `/api/v1/catalog/search` | Search ACP catalog products | Public |
| `POST` | `/api/v1/mandates/intent` | Issue Intent Mandate (spend cap) | `x-agent-id` |
| `POST` | `/api/v1/mandates/cart` | Submit Cart Mandate with AI reasoning | `x-agent-id` |
| `POST` | `/api/v1/mandates/cart/:id/approve` | Human approval gate | `x-agent-id` |
| `POST` | `/api/v1/payments/execute` | Execute Razorpay payment | `x-agent-id` + JWT |
| `GET` | `/api/v1/audit/trails/:id` | Fetch full immutable audit log | Public |

---

