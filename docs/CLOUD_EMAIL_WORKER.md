# ReachInbox — Free Cloud Email Worker Architecture & Deployment Guide

This document describes the cloud deployment architecture designed to remove the local laptop dependency for external evaluators using 100% free-tier cloud services.

---

## 1. Cloud Infrastructure Architecture

```
┌─────────────────┐       ┌─────────────────┐       ┌────────────────────────┐
│  Vercel (UI)    │ ----> │ Render.com Free │ ----> │ Neon PostgreSQL (DB)   │
│  React SPA      │       │ Express Backend │       │ Serverless Postgres 16 │
└─────────────────┘       └────────┬────────┘       └───────────┬────────────┘
                                   │                            │
                                   ▼                            ▼
                          ┌─────────────────┐       ┌────────────────────────┐
                          │ Upstash Redis   │ <---  │ GitHub Actions Worker  │
                          │ TLS rediss://   │       │ Bounded Cloud Worker   │
                          └─────────────────┘       └────────────────────────┘
```

| Component | Cloud Provider | Free Tier Limits | Purpose |
| :--- | :--- | :--- | :--- |
| **Frontend** | **Vercel** | Unlimited static hosting | Host React SPA and dashboard UI |
| **Backend API** | **Render.com** | 750 free instance hrs/month | Express REST API, auth, preflight, analytics |
| **Database** | **Neon.tech** | 0.5 GB storage, serverless compute | PostgreSQL with schema migrations, outbox, delivery state machine |
| **Queue / Cache** | **Upstash** | 10,000 commands/day, TLS enabled | BullMQ `email-queue` and distributed mutex locking |
| **Email Worker** | **GitHub Actions** | 2,000 minutes/month | Ephemeral one-shot bounded worker (runs every 5m / workflow_dispatch) |

---

## 2. Bounded Worker Design & Queue Polling

### How the Bounded Worker Operates
Rather than running an expensive 24/7 background daemon, the bounded worker executes in **one-shot bounded bursts**:
1. **Startup Reconciliations**: Reconciles any stale in-flight deliveries (`reconcileStaleDeliveries`) and recovers scheduled deliveries from `delivery_outbox` into BullMQ.
2. **Batch Processing**: Processes pending BullMQ email jobs using the canonical `processEmailJob()` engine (preserving idempotency, rate limits, inter-send spacing, and attempt audits).
3. **Queue Drain & Idle Exit**: If the queue is empty and stays idle for `15 seconds` (`WORKER_IDLE_TIMEOUT_SECONDS`), the worker shuts down cleanly (exit code `0`), having consumed only ~20–30 seconds of compute.
4. **Hard Time Boundary**: If a very large queue is being drained, the worker enforces a hard ceiling of `4 minutes` (`WORKER_MAX_DURATION_SECONDS = 240`) and shuts down before the next 5-minute cron cycle.

### Queue Polling Delay & Trigger Semantics
* **Scheduled Trigger Requirement**:
  > [!IMPORTANT]
  > GitHub Actions scheduled triggers (`on.schedule` / `cron`) **strictly require** the workflow file to be present on the repository's **default branch** (`main` or `master`). Workflows on feature branches will not trigger on schedule until merged into default.
* **Manual Trigger (`workflow_dispatch`)**:
  * Evaluators can trigger an immediate dispatch at any time via **GitHub Actions → "ReachInbox Cloud Email Worker" → "Run workflow"** (`workflow_dispatch`) from any branch where the workflow exists, reducing delay to ~15 seconds.
* **Schedule Interval & Jitter**:
  * An email scheduled for immediate dispatch will be picked up within **0 to 5 minutes** (governed by the GitHub Actions cron window).
  * GitHub Actions cron triggers may experience 30–60 seconds of queue runner assignment jitter during peak GitHub traffic periods.

---

## 3. Two-Tier Concurrency Protection

To guarantee that two worker executions cannot run concurrently or cause race conditions:

1. **Orchestrator Concurrency (GitHub Actions)**:
   ```yaml
   concurrency:
     group: email-worker
     cancel-in-progress: false
   ```
   Ensures that if a workflow is currently executing, subsequent cron or manual runs queue up rather than executing in parallel or terminating active deliveries mid-send.

2. **Application-Level Distributed Mutex (Redis)**:
   The worker acquires an atomic Redis lock (`reachinbox:worker:bounded-lock`) using `SET key instanceId NX PX ttlMs`.
   * If a lock is held by another worker instance, the incoming worker logs a notice and exits cleanly with exit code `0`.
   * Lock TTL is renewed via heartbeat while processing.
   * Lock is safely released upon completion using an atomic Lua script comparing `instanceId`.

---

## 4. GitHub Actions Usage & Visibility Analysis (Public vs. Private)

| Repository Visibility | Usage Billing | Impact & Evaluation Guidance |
| :--- | :--- | :--- |
| **Public Repository** | **100% Free & Unlimited** | GitHub Actions execution is completely free with no monthly minute ceiling on standard GitHub-hosted runners. Recommended for evaluation portfolios. |
| **Private Repository** | **2,000 minutes / month** | GitHub rounds every job run up to the nearest whole minute. A 5-minute cron produces `12 runs/hr * 24 hr * 30 days = 8,640 billable minutes/month`, exceeding the 2,000-minute free quota. |

### Private Repository Best Practices:
1. **On-Demand Evaluation**: Use manual `workflow_dispatch` ("Run workflow") for reviewer demonstrations (consumes only ~1 billable minute per test run).
2. **Relaxed Cron Cadence**: If scheduled runs are needed on a private repository without billing, set schedule to hourly (`0 * * * *`), consuming only 720 minutes/month (<36% of the 2,000-minute allowance).

---

## 5. Free-Tier Cloud Limits & Mitigations

| Limitation | Impact | Mitigation Strategy |
| :--- | :--- | :--- |
| **Neon Compute Auto-Suspend** | Neon suspends compute after 5 minutes of inactivity; initial connection takes ~2–3s. | Backend and worker use a 5-second connection timeout with automatic reconnection and strict SSL. |
| **Render Web Service Inactivity** | Render free web service spins down after 15 minutes of inactivity; wake-up takes ~30–50s. | Frontend displays loading indicators; wake-up call triggers backend container initialization. |
| **Upstash Daily Command Ceiling** | 10,000 commands/day limit on free tier. | Bounded worker polls BullMQ at 2,000ms intervals during active bursts; closes connection immediately when idle. |

---

## 6. Deployment Checklist & Secrets Setup

### Cloud Worker Secrets (GitHub Actions)
Configure the following minimal secrets in **GitHub Repository Settings → Secrets and variables → Actions**:

* `DATABASE_URL`: `postgresql://<user>:<password>@<neon-host>/<dbname>?sslmode=require`
* `REDIS_URL`: `rediss://default:<password>@<upstash-host>:6379`
* `ENCRYPTION_KEY`: 64-character hex key (32 bytes) for AES-256-GCM SMTP credential decryption

*(Note: OAuth, Slack, and Gemini API keys are only required by the Render Backend API web server and are not required by the cloud worker runtime).*

### Backend Web Server Secrets (Render.com Dashboard)
* `DATABASE_URL`, `REDIS_URL`, `ENCRYPTION_KEY`
* `JWT_SECRET`: Random 32+ character string
* `GEMINI_API_KEY`: Google Gemini API key for Copilot features
* `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`: Google OAuth credentials
* `SLACK_CLIENT_ID` / `SLACK_CLIENT_SECRET`: Slack App credentials
