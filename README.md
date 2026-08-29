# ReachInbox Full-Stack Email Job Scheduler

[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue.svg)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-20.x-green.svg)](https://nodejs.org/)
[![Express](https://img.shields.io/badge/Express-4.x-lightgrey.svg)](https://expressjs.com/)
[![BullMQ](https://img.shields.io/badge/BullMQ-6.x-red.svg)](https://bullmq.io/)
[![Redis](https://img.shields.io/badge/Redis-7.x-dc382d.svg)](https://redis.io/)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-16.x-336791.svg)](https://www.postgresql.org/)
[![Elasticsearch](https://img.shields.io/badge/Elasticsearch-8.x-005571.svg)](https://www.elastic.co/)
[![React](https://img.shields.io/badge/React-18.x-61dafb.svg)](https://reactjs.org/)
[![Vite](https://img.shields.io/badge/Vite-5.x-646cff.svg)](https://vitejs.dev/)

A production-grade, highly reliable, distributed email job scheduler built for high-throughput transactional and marketing email campaigns. Designed to satisfy all hiring assignment requirements with zero shortcuts, strictly enforced multi-tenancy, rate-limiting, failure resilience, and exact UTC epoch scheduling.

---

## ⚡ Core Architecture Principles

> [!IMPORTANT]
> **NO CRON JOBS ARE USED IN THIS APPLICATION.**
> - **Scheduling Mechanism:** 100% powered by **BullMQ Delayed Jobs** using exact millisecond arithmetic: `delayMs = Math.max(0, new Date(scheduledAt).getTime() - Date.now())`.
> - **Persistent Queue Backend:** **Redis 7** persists all queued and delayed jobs across crashes and worker restarts.
> - **System of Record:** **PostgreSQL 16** is the transactional source of truth (users, senders, campaigns, recipients, email_logs, slack_integrations).
> - **Search Engine:** **Elasticsearch 8** provides real-time full-text indexing and fast search across email subjects, recipient emails, and body content.
> - **SMTP Delivery:** **Nodemailer + Ethereal SMTP** provides isolated sandbox delivery with instant web preview links.
> - **Rate-Limit Alerts:** **Slack OAuth 2.0 + Incoming Webhooks** delivers real-time notifications with Redis-backed per-hour deduplication.

---

## 🏛️ System Architecture

```mermaid
graph TD
    Client["React + Vite Single Page App (Port 5173)"]
    API["Express.js REST API (Port 5001)"]
    Postgres[("PostgreSQL 16 (System of Record)")]
    RedisQueue[("Redis 7 (BullMQ Queue & Atomic Rate Limits)")]
    Workers["Distributed BullMQ Workers (Concurrency: 2 - 10)"]
    Elastic[("Elasticsearch 8 (Full-Text Search Index)")]
    SMTP["Ethereal SMTP / Mail Server"]
    Slack["Slack Webhook API (Rate Limit Alerts)"]
    BullBoard["Bull Board Admin UI (/admin/queues)"]

    Client -->|HTTP / REST API + Cookies| API
    API -->|Session & User Auth| Postgres
    API -->|CRUD & Validation| Postgres
    API -->|Bulk Index Scheduled Emails| Elastic
    API -->|Enqueue Exact Delayed Jobs| RedisQueue
    API -->|Monitor Queue Health| BullBoard
    
    Workers -->|Atomic Lock & Spacing Check| RedisQueue
    Workers -->|Atomic Lua Rate Limit Check| RedisQueue
    Workers -->|Re-Delay When Rate Limited| RedisQueue
    Workers -->|Load Sender & Campaign Details| Postgres
    Workers -->|Record Send / Failure Logs| Postgres
    Workers -->|Update Index Status: 'sent'| Elastic
    Workers -->|Dispatch Email via TLS/SMTP| SMTP
    Workers -->|Trigger Rate Limit Notification| Slack
```

---

## 🚀 Quick Start (Local Setup)

### 1. Prerequisites
- Node.js ≥ 20.x
- Docker & Docker Compose
- npm ≥ 10.x

### 2. Infrastructure Services
Start PostgreSQL, Redis, and Elasticsearch containers:
```bash
docker compose up -d
```

Verify services are healthy:
- **PostgreSQL:** `localhost:5432` (`reachinbox` database)
- **Redis:** `localhost:6379`
- **Elasticsearch:** `http://localhost:9200`

### 3. Backend Setup
```bash
cd backend
cp .env.example .env
npm install
npm run db:migrate
npm run dev
```
Backend API will start on `http://localhost:5001`.
Bull Board queue monitor available at `http://localhost:5001/admin/queues`.

### 4. Email Worker Setup (Dedicated Process)
Open a separate terminal to run the standalone background worker:
```bash
cd backend
npm run worker
```

### 5. Frontend Setup
Open a third terminal:
```bash
cd frontend
cp .env.example .env
npm install
npm run dev
```
Frontend UI will start on `http://localhost:5173`.

---

## 🔑 Environment Configuration

### Backend (`backend/.env`)
| Variable | Description | Default |
|---|---|---|
| `PORT` | API listen port | `5001` |
| `NODE_ENV` | Application environment | `development` |
| `DATABASE_URL` | PostgreSQL connection URL | `postgresql://postgres:postgres@localhost:5432/reachinbox` |
| `REDIS_HOST` | Redis host | `localhost` |
| `REDIS_PORT` | Redis port | `6379` |
| `SESSION_SECRET` | Express session encryption secret | 64-char hex string |
| `GOOGLE_CLIENT_ID` | Google OAuth client ID | (Configured) |
| `GOOGLE_CLIENT_SECRET`| Google OAuth client secret | (Configured) |
| `GOOGLE_CALLBACK_URL` | Google OAuth callback | `http://localhost:5001/auth/google/callback` |
| `SMTP_HOST` | Ethereal/Custom SMTP host | `smtp.ethereal.email` |
| `SMTP_PORT` | SMTP port | `587` |
| `SMTP_SECURE` | TLS/SSL flag | `false` |
| `SMTP_USER` | SMTP username | (Configured) |
| `SMTP_PASS` | SMTP password | (Configured) |
| `EMAIL_SEND_DELAY_MS` | Global spacing between sends | `2000` |
| `ELASTICSEARCH_URL` | Elasticsearch cluster URL | `http://localhost:9200` |
| `ELASTICSEARCH_INDEX` | Index name for email search | `reachinbox-emails` |
| `SLACK_CLIENT_ID` | Slack OAuth app Client ID | (Configured) |
| `SLACK_CLIENT_SECRET`| Slack OAuth app Client Secret | (Configured) |
| `SLACK_REDIRECT_URI` | Slack OAuth callback URL | `http://localhost:5001/auth/slack/callback` |

---

## 📡 REST API Reference

### 🔐 Authentication (`/auth`)
- `GET /auth/me` — Return current authenticated user profile and session state.
- `GET /auth/google` — Initiate Google OAuth 2.0 login flow.
- `GET /auth/google/callback` — Google OAuth 2.0 redirect callback.
- `POST /auth/logout` — Destroy current session and clear session cookies.

### 💬 Slack OAuth 2.0 Integration (`/auth/slack`)
- `GET /auth/slack` — Initiate Slack OAuth flow (`incoming-webhook` scope).
- `GET /auth/slack/callback` — Slack OAuth callback; exchanges authorization code and saves encrypted webhook in PostgreSQL.
- `GET /auth/slack/status` — Get current user's Slack connection status (workspace and channel name).
- `DELETE /auth/slack` — Disconnect Slack workspace and remove webhook.

### 📮 Senders Management (`/senders`)
- `GET /senders` — List all configured SMTP senders for authenticated user.
- `POST /senders` — Add new SMTP sender account (with credentials).
- `GET /senders/:id` — Get sender details by ID.
- `PATCH /senders/:id` — Update sender configuration.
- `DELETE /senders/:id` — Delete sender account (restricted if referenced by active campaigns).

### 🚀 Campaigns & Job Dispatch (`/campaigns`)
- `GET /campaigns` — List user's email campaigns with status and stats.
- `POST /campaigns` — Create and schedule campaign (CSV recipient upload, subject/body templating with `{{name}}`, `sender_id`, `hourly_limit`, and future `scheduled_at` timestamp).
- `GET /campaigns/:id` — Get campaign details, recipient list, and email delivery logs.
- `DELETE /campaigns/:id` — Delete campaign and cascade recipient logs.

### 🔍 Elasticsearch Full-Text Search (`/emails`)
- `GET /emails/search?q=<query>&status=<sent|scheduled|failed>&limit=20&page=1` — High-speed search across authenticated user's scheduled and sent emails.

### 📊 Bull Board Monitoring (`/admin/queues`)
- Interactive UI to monitor `email-queue` metrics: Active, Waiting, Delayed, Completed, Failed jobs, and retry controls.

---

## 🧪 Comprehensive Automated Test Matrix

The project includes 12 automated verification suites covering every subsystem:

| Test Command | Scope & Verification |
|---|---|
| `npm run db:test` | PostgreSQL schema, tables, foreign keys, cascade deletes, indices |
| `npm run queue:test` | BullMQ basic enqueuing, delayed job execution, retry backoff |
| `npm run email:test` | Nodemailer SMTP dispatch, TLS handshake, Ethereal preview links |
| `npm run rate-limit:test` | Redis atomic Lua rate-limiter, burst throttling, window promotion |
| `npm run recovery:test` | Worker crash simulation, Redis queue persistence, restart pickup |
| `npm run slack:test` | Slack incoming webhook delivery, rich Block Kit formatting |
| `npm run slack-oauth:test` | Full Slack OAuth 2.0 flow, CSRF protection, tenant isolation |
| `npm run slack-integration:test` | Real rate-limit triggers, 1-per-hour alert deduplication, failure isolation |
| `npm run search:test` | Elasticsearch indexing, query matching, user tenancy isolation, outage safety |
| `npm run search:reindex` | PostgreSQL to Elasticsearch bulk re-indexer migration tool |
| `npm run sender:test` | Multi-sender isolation, per-campaign sender routing, delete protection |
| `npm run scheduled-recovery:test`| Exact-time scheduled job survival across worker restarts |
| `npm run load:test` | 1000-job stress test: concurrency 10, rate limiting, zero dropped jobs |

Run all tests from the backend folder:
```bash
cd backend
npm run db:test
npm run queue:test
npm run email:test
npm run rate-limit:test
npm run search:test
npm run sender:test
npm run slack-oauth:test
npm run scheduled-recovery:test
npm run load:test
```

---

## 🛡️ Security & Reliability Architecture

1. **Multi-Tenant Data Isolation:** Every database query strictly filters by `user_id = req.user.id`. Users cannot view, modify, or delete another tenant's senders, campaigns, or Slack webhooks.
2. **Credential Protection:** SMTP passwords and Slack access tokens are never exposed in REST API responses or console logs.
3. **CSRF & State Validation:** All OAuth endpoints (Google and Slack) generate cryptographically random state tokens stored in server-side session cookies to prevent CSRF attacks.
4. **Third-Party Failure Isolation:** Slack webhook outages or Elasticsearch network failures are wrapped in defensive try/catch blocks; external service downtime never crashes the worker or blocks email delivery.
5. **Idempotency Guarantee:** Duplicate job submissions (e.g. from network retries or re-enqueues) are automatically skipped via atomic PostgreSQL `email_logs` checks.

---

## 👥 Contributors & Submission Details
- **Assignment:** ReachInbox Full-Stack Email Job Scheduler
- **Technology Stack:** TypeScript, Express.js, BullMQ, Redis, PostgreSQL, Elasticsearch, Nodemailer, Slack API, React, Vite
- **License:** MIT
