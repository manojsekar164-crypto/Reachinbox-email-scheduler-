# ReachInbox Scheduler – Backend (Phase 1)

Production-ready backend foundation built with **TypeScript · Node.js · Express · PostgreSQL · Redis**.

---

## Prerequisites

| Tool | Version |
|------|---------|
| Node.js | ≥ 20 |
| npm | ≥ 10 |
| Docker & Docker Compose | any recent |

---

## Quick Start

### 1 – Clone & install

```bash
git clone <repo>
cd backend
npm install
```

### 2 – Environment variables

```bash
cp .env.example .env
# Edit .env if needed (defaults work with Docker Compose)
```

### 3 – Start infrastructure (Postgres + Redis)

```bash
docker compose up -d
```

### 4 – Run the dev server

```bash
npm run dev
```

Expected console output:

```
✅  PostgreSQL connected
✅  Redis connected
🚀  Server running on port 5000 [development]
```

### 5 – Verify health endpoint

```bash
curl http://localhost:5000/health
```

Response:

```json
{
  "status": "ok",
  "service": "reachinbox-scheduler"
}
```

---

## npm Scripts

| Script | Description |
|--------|-------------|
| `npm run dev` | Run with `ts-node-dev` (hot-reload) |
| `npm run build` | Compile TypeScript → `dist/` |
| `npm start` | Run compiled JS from `dist/server.js` |

---

## Project Structure

```
backend/
├── src/
│   ├── config/
│   │   └── index.ts          # Centralised config (env vars)
│   ├── controllers/
│   │   └── health.controller.ts
│   ├── db/
│   │   ├── postgres.ts       # pg Pool + connect/disconnect helpers
│   │   └── redis.ts          # ioredis client + connect/disconnect helpers
│   ├── middleware/
│   │   ├── errorHandler.ts   # AppError class, 404 handler, global error handler
│   │   └── requestLogger.ts  # Dev-mode request logger
│   ├── routes/
│   │   ├── index.ts          # Root router
│   │   └── health.routes.ts  # GET /health
│   ├── services/
│   │   └── index.ts          # Placeholder for Phase 2+ services
│   ├── types/
│   │   └── index.ts          # Shared TypeScript types
│   ├── app.ts                # Express app factory
│   └── server.ts             # Bootstrap: connect DBs → start server
├── .env.example
├── docker-compose.yml
├── package.json
├── tsconfig.json
└── README.md
```

---

## Docker Compose Services

| Service | Image | Port |
|---------|-------|------|
| `postgres` | postgres:16-alpine | 5432 |
| `redis` | redis:7-alpine | 6379 |

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `5000` | HTTP server port |
| `NODE_ENV` | `development` | Environment mode |
| `DATABASE_URL` | `postgresql://postgres:postgres@localhost:5432/reachinbox` | Postgres connection string |
| `REDIS_HOST` | `localhost` | Redis hostname |
| `REDIS_PORT` | `6379` | Redis port |

---

## Phase Roadmap

- ✅ **Phase 1** – Backend foundation
- ✅ **Phase 2** – Database schema & migrations
- ✅ **Phase 3** – Google OAuth & express-session authentication
- ✅ **Phase 4** – Campaign Creation + Recipients API
- ✅ **Phase 5** – BullMQ + Redis Queue
- ✅ **Phase 6** – Email Sending with Nodemailer + Ethereal
- ✅ **Phase 7** – Rate Limiting and Persistence / Recovery
- ✅ **Phase 8** – Slack Integration
- ✅ **Phase 9B** – Multiple Senders
- ✅ **Phase 9C** – Minimum Send Delay Between Emails *(Current)*

---

## Phase 4: Campaign Creation + Recipients API

### Overview
This phase introduces a secure, transaction-backed API for creating and managing email campaigns and their recipients. It handles all necessary database relationships atomically and ensures complete data isolation between authenticated users.

### Authentication & Ownership
- **Authentication**: All endpoints under `/campaigns` are protected by the `requireAuth` middleware. Unauthenticated requests return `401 Unauthorized`.
- **Ownership**: The authenticated user ID is strictly extracted from `req.user.id`. The user ID is never trusted from the request body. Database queries enforce ownership by appending `AND user_id = $userId`.

### Transaction Behavior
When a campaign is created via `POST /campaigns`, the insertion of the campaign and all its recipients occurs inside a single PostgreSQL transaction (`BEGIN` / `COMMIT` / `ROLLBACK`). If any recipient fails to insert (e.g. database error), the entire transaction is rolled back, preventing orphaned campaign records.

### API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/campaigns` | Create a new campaign and its recipients |
| GET | `/campaigns` | List all campaigns belonging to the user |
| GET | `/campaigns/:id` | Get details for a specific campaign |
| PATCH | `/campaigns/:id` | Update campaign fields |
| DELETE | `/campaigns/:id` | Delete a campaign (cascades to recipients) |
| GET | `/campaigns/:id/recipients` | List all recipients for a campaign |

### Examples

**POST /campaigns (Request)**
```json
{
  "subject": "Meeting Follow-up",
  "body": "Hello {{name}}, just following up...",
  "scheduled_at": "2026-08-30T10:00:00Z",
  "hourly_limit": 5,
  "recipients": [
    {
      "email": "john@example.com",
      "name": "John"
    },
    {
      "email": "jane@example.com",
      "name": "Jane"
    }
  ]
}
```

**POST /campaigns (Response 201 Created)**
```json
{
  "id": "bd6bd56d-f93e-4441-bf2d-bab937f2c090",
  "user_id": "c7d685b9-77f6-4bf4-88a6-5f0b12ec8e05",
  "subject": "Meeting Follow-up",
  "body": "Hello {{name}}, just following up...",
  "scheduled_at": "2026-08-30T10:00:00.000Z",
  "hourly_limit": 5,
  "status": "draft",
  "created_at": "2026-08-28T13:21:26.438Z",
  "updated_at": "2026-08-28T13:21:26.438Z",
  "recipients": [
    {
      "id": "e8d9c123-abc4...",
      "campaign_id": "bd6bd56d-f93e-4441-bf2d-bab937f2c090",
      "email": "john@example.com",
      "name": "John",
      "status": "pending",
      "created_at": "2026-08-28T13:21:26.442Z"
    }
  ]
}
```

### Testing (Integration Tests)

To verify the transaction logic, cascade deletes, and functionality of Phase 4, you can run the integration test script directly:

```bash
npx ts-node src/scripts/testCampaigns.ts
```

---

## Phase 5: BullMQ + Redis Queue

### Overview
This phase introduces BullMQ for asynchronous background job processing. It sets up a dedicated queue (`email-queue`) backed by our existing Redis configuration, and provides a standalone worker process that handles jobs independently of the Express API lifecycle.

### Queue Architecture & Redis Role
- **Queue**: A dedicated BullMQ `Queue` instance (`email-queue`) handles dispatching job payloads.
- **Job Payload**: Contains exactly what is needed to process an email, preventing unnecessary large database records from bloating the queue:
  ```json
  {
    "campaignId": "uuid",
    "recipientId": "uuid"
  }
  ```
- **Redis**: The existing Redis configuration (`config.redis`) is seamlessly reused. We provision isolated IORedis instances customized for BullMQ (setting `maxRetriesPerRequest: null`).
- **Worker**: A BullMQ `Worker` listens on `email-queue` and processes jobs. It is completely decoupled from the HTTP API and runs in its own process.

### Configuration & Concurrency
We configure the queue with sensible defaults:
- **Attempts**: 3 (safeguard against transient failures).
- **Backoff**: Exponential with a 5000ms delay.
- **RemoveOnComplete**: True (prevents memory bloat in Redis for successful jobs).
- **Concurrency**: 2 (Processes up to 2 email jobs concurrently in development, avoiding overwhelming local systems while demonstrating parallel execution).

### API & Dashboard
A development-only queue dashboard powered by `@bull-board` is exposed on the Express API.
- **Dashboard URL**: `http://localhost:5001/admin/queues`
- Shows visual statuses: Waiting, Active, Completed, Failed, Delayed.

### Testing & Execution

**1. Run the Worker Process**
In a new terminal window, start the standalone worker:
```bash
npm run worker
```

**2. Run the Queue Tests**
We provide an independent test script to verify queue logic without HTTP endpoints:
```bash
npm run queue:test
```
This script demonstrates:
- Adding an immediate job.
- Adding a delayed job (waits 5 seconds).
- Adding a failing job (triggers BullMQ's automatic retry logic).

### Development Limitations
- **No Real Emails Sent**: The worker logs the `campaignId` and `recipientId` to simulate processing. Real SMTP integration is reserved for future phases.
- **Manual Queueing**: Campaigns do not automatically queue jobs on creation yet, allowing pure independent verification of the queue infrastructure.

---

## Phase 6: Email Sending with Nodemailer + Ethereal

### Overview
This phase introduces actual email processing via Nodemailer, using Ethereal SMTP as a safe, local development provider. We read the `campaigns` and `recipients` from PostgreSQL, merge template variables, log the success or failure in the `email_logs` table, and integrate fully with BullMQ's native retries.

### Why Nodemailer & Ethereal?
- **Nodemailer**: The industry standard for sending emails in Node.js. It provides a robust `transporter` architecture.
- **Ethereal SMTP**: A fake SMTP service specifically designed for development. It captures outgoing emails and provides a web-based interface (and preview URLs) to inspect them, ensuring we never accidentally send test emails to real users.
- **No Production Infrastructure Yet**: By using Ethereal, we avoid limits, spam concerns, and the need for a real provider (like AWS SES, Resend, or Sendgrid) during local development. 

### Environment Setup
You must configure Ethereal SMTP in your `.env` file. You can generate a free account instantly at [ethereal.email](https://ethereal.email/create) or run the provided setup scripts. 
```env
SMTP_HOST=smtp.ethereal.email
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=your_ethereal_user@ethereal.email
SMTP_PASS=your_ethereal_pass
EMAIL_FROM=no-reply@reachinbox.test
```

### Architecture
1. **`emailService.ts`**: Encapsulates Nodemailer logic. Creates a single, reusable `transporter` instance and exposes `sendEmail()`. It returns the Nodemailer `messageId` and a generated `previewUrl`.
2. **Worker Flow**:
   - The BullMQ worker (`emailWorker.ts`) receives `campaignId` and `recipientId`.
   - It fetches the campaign and recipient data from PostgreSQL.
   - It performs an **idempotency check** against `email_logs` to ensure it hasn't already sent an email for this pair.
   - It dynamically replaces `{{name}}` with the recipient's name in the subject and body.
   - It attempts to send the email via `emailService`.
   - On success, it logs `status = 'sent'` in `email_logs`.
   - On failure, it logs `status = 'failed'` and rethrows the error to BullMQ, triggering the retry backoff.

### Idempotency & Retry Behavior
- **Idempotency**: Critical for distributed workers. If a job fails or is processed twice, the worker checks `SELECT * FROM email_logs WHERE status = 'sent'`. If an email was already sent successfully, the duplicate execution is skipped entirely.
- **Retry**: BullMQ automatically retries failed jobs using an exponential backoff. The worker logs every failure attempt in `email_logs` as `failed`, so a single job might have multiple `failed` logs followed by a `sent` log.

### Testing Commands
We provide several test scripts to verify Phase 6:

**1. Isolated SMTP Test**
Verifies your Ethereal credentials and sends one test email without touching the database:
```bash
npm run email:test
```
*Expected Output*: Connects, sends, and prints a clickable Ethereal Preview URL.

**2. Full Worker Integration Test**
Tests the complete end-to-end flow including database extraction, idempotency, and failure retries. Ensure your worker (`npm run worker`) is running, then execute:
```bash
npx ts-node src/scripts/testEmailIntegration.ts
```
*Expected Output*: Validates the success path, ensures duplicate jobs are blocked by idempotency, and confirms that simulated failures trigger BullMQ retries which eventually succeed.

### Development Limitations
- **No Automatic Polling (No Cron)**: Campaigns are not automatically picked up based on `scheduled_at` yet. We manually inject them into the queue for testing. (Cron behavior is reserved for future phases).
- **Simple Templates**: String replacement is used for `{{name}}` instead of a full templating engine like Handlebars.

---

## Phase 7: Rate Limiting and Persistence / Recovery

### Overview
This phase introduces strict per-campaign rate limiting backed by Redis, ensuring that a campaign does not exceed its configured `hourly_limit` of successful emails. It also guarantees that rate-limited jobs are safely delayed and persisted using BullMQ, surviving worker or API restarts.

### Rate Limiting vs. Concurrency
- **Concurrency** (`worker concurrency = 2`): Dictates how many jobs the worker can process at the exact same moment across all campaigns.
- **Rate Limiting** (`hourly_limit = 5`): A business rule dictating the maximum number of successful emails a specific campaign can send within a 1-hour rolling window, regardless of how fast the worker is.

### Redis-Backed State & Atomicity
- **Why Redis?** The rate-limit counter must be stored in Redis rather than process memory so that multiple worker instances can share the same exact limit.
- **Key Format**: `rate-limit:campaign:<campaignId>`
- **Atomicity**: We use a Redis Lua script (`src/services/rateLimiter.ts`) to atomically check the current count, increment it if under the limit, and set the expiration TTL. This prevents race conditions where two concurrent workers might simultaneously check the limit and exceed it.
- **TTL/Window Behavior**: The Redis key expires automatically when the time window passes (e.g., 3600 seconds).

### Delayed Job Behavior
If a job attempts to process but the campaign has reached its hourly limit:
- The job is **NOT** failed.
- We calculate the remaining TTL on the rate-limit Redis key.
- The job is moved to BullMQ's `delayed` state for that remaining duration.
- Once the time expires, BullMQ automatically promotes the job back to `waiting`, and it processes successfully.
- **Idempotency Interaction**: The idempotency check (verifying if an email was already sent) happens *before* consuming the rate limit. A duplicate job will not consume a rate-limit slot.
- **Retry Interaction**: If an email send fails (e.g., SMTP error), we throw an error to trigger BullMQ's retry backoff. The initial failure already consumed a rate limit slot (since we attempt to send), but subsequent retries that finally succeed will not double-consume slots if appropriately managed, as rate limits are consumed immediately prior to the send attempt.

### Persistence & Recovery (Restart Behavior)
- **Durability**: Redis persists the BullMQ state and the rate-limit keys to disk (via Docker volume). 
- If the Express API or Worker process is restarted, any `delayed` or `waiting` jobs remain safely in Redis. When the worker comes back online, it resumes processing exactly where it left off. No emails are lost.

### Configuration & Testing
- **Production Window**: By default, the window is `3600` seconds (1 hour) controlled by the `RATE_LIMIT_WINDOW_SECONDS` environment variable.
- **Development Test Window**: We use a much shorter window (e.g., 10-15 seconds) inside our test scripts (`testRateLimit.ts` and `testRecovery.ts`) to verify behavior without waiting an hour.

You can verify Phase 7 functionality using the provided test scripts:
```bash
npm run rate-limit:test
npm run recovery:test
```

### Known Limitations
- If a worker crashes exactly between consuming the rate limit in Redis and actually dispatching the email via SMTP, that single rate-limit slot is "lost" for the duration of the window (the email isn't sent, but the limit is decremented). This is an acceptable tradeoff for simplicity over a complex reservation/release saga pattern.
- Slack notifications are now fully implemented (Phase 8).

---

## Phase 8: Slack Integration

### Overview
This phase introduces Slack notifications for campaign rate-limit events. When a campaign exceeds its hourly limit of successful sends, its pending email jobs are safely delayed using BullMQ, and a formatted notification is triggered and sent to a Slack channel using Incoming Webhooks. 

### Why Slack is Used
Slack notifications provide real-time visibility and monitoring into the scheduler's operations. Admins and users are immediately alerted when outreach campaigns are throttled due to rate-limiting policies, allowing them to adjust campaign limits, check resource utilization, or plan follow-ups without checking raw database or queue logs.

### Incoming Webhook Explanation
We use **Slack Incoming Webhooks**, which is the simplest and most secure way to post messages from external services into Slack channels. It does not require complex Slack OAuth setups, bot installations, socket modes, or user credentials. It operates purely as a secure, one-way HTTP POST endpoint:
1. Validates the webhook URL format.
2. Formats a payload in JSON containing the alert message.
3. Sends an HTTP POST to the webhook URL.

### Environment Variable
The webhook URL must be stored in the environment configuration to prevent hardcoding secrets.
Add to `.env`:
```env
# Slack Integration
SLACK_WEBHOOK_URL=https://hooks.slack.com/services/T.../B.../X...
```
*Note: In development and test environments, if `SLACK_WEBHOOK_URL` is empty, HTTP calls are gracefully skipped while local test state asserts are fully supported.*

### Slack Service Architecture
The integration is abstracted inside `src/services/slackService.ts` and exports:
- **`sendSlackNotification(text)`**: Low-level helper that fires a standard `fetch` call with a maximum timeout of 5 seconds (using `AbortSignal.timeout`). Catches timeout, network, and HTTP errors safely, and guarantees the secret webhook URL is never logged.
- **`handleRateLimitNotification(campaignId, hourlyLimit, waitMs)`**: Orchestrates the rate limit alert process. Computes the window epoch, checks Redis for deduplication, queries Postgres to resolve campaign details (subject), structures the alert text, and calls the webhook helper.

### Rate-Limit Notification Flow
```
Worker retrieves Job -> Rate Limit Check (Lua script) -> Limit Exceeded
                                                              ↓
                                                    Delay Job in BullMQ
                                                              ↓
                                            Call handleRateLimitNotification()
                                                              ↓
                                                 Check Deduplication in Redis
                                                              ↓
                                                  (If First Time in Window)
                                                              ↓
                                                     Resolve Campaign Subject
                                                              ↓
                                                      Send Slack Webhook
```

### Notification Deduplication (Redis Key & TTL)
To prevent spamming the Slack channel with multiple alerts for every single recipient that gets throttled within the same rate limit window, we apply an atomic Redis deduplication strategy:
- **Redis Key**: `slack:ratelimit:notified:<campaignId>:<windowEpoch>`
  - `<windowEpoch>`: Unix timestamp (in seconds) representing when the current rate limit window resets, calculated deterministically as `Math.floor((Date.now() + waitMs) / 1000)`.
- **Value**: `"1"`
- **TTL**: `waitMs` (the remaining duration of the rate-limiting window in milliseconds) set via the Redis `PX` argument.
- **NX Option**: Set only if the key does not already exist. If setting fails, we skip sending the Slack notification, guaranteeing exactly **one** alert is sent per campaign per rate-limit window. The key automatically self-destructs when the window resets.

### Slack Failure Isolation
A failure in Slack notification delivery (such as network timeout, invalid webhook URL, Slack server downtime, etc.) will **NEVER** interfere with the email scheduler or fail the BullMQ jobs:
- The `handleRateLimitNotification` method wraps the entire notification routine inside a `try/catch` block.
- Any error encountered is logged to the console safely (without exposing secrets).
- The error is swallowed and not rethrown.
- The worker proceeds to delay the email job normally.

### Testing & Execution

**1. Verify Configuration Connectivity**
Run the quick Slack connectivity test script:
```bash
npm run slack:test
```

**2. Run the Full Slack Integration Suite**
Verify the rate limit alert, notification deduplication, and failure isolation tests:
```bash
npm run slack-integration:test
```

---

## Phase 9B: Multiple Senders

### Overview
This phase introduces support for configuring multiple email senders. The system allows different outreach campaigns to send emails from different Ethereal SMTP accounts, ensuring sender identity isolation.

### Multiple Sender Architecture
```
Sender A (Ethereal SMTP Account A)  ──>  Campaign A  ──>  Worker  ──>  Email (From: Sender A)
Sender B (Ethereal SMTP Account B)  ──>  Campaign B  ──>  Worker  ──>  Email (From: Sender B)
```
Each campaign maps to exactly one configured sender (`campaigns.sender_id -> senders.id`). When the background worker processes email jobs for a campaign, it dynamically retrieves the sender's SMTP credentials and sends the email through that specific Nodemailer transporter.

### Sender Database Model (`senders` table)
- **`id`** (`UUID`, Primary Key): Generated using `gen_random_uuid()`.
- **`user_id`** (`UUID`, Foreign Key): Links to `users.id` with `ON DELETE CASCADE`.
- **`name`** (`VARCHAR`, Not Null): Display name of the sender.
- **`email`** (`VARCHAR`, Not Null): Sender email address.
- **`smtp_host`** (`VARCHAR`, Not Null): SMTP hostname (e.g., `smtp.ethereal.email`).
- **`smtp_port`** (`INTEGER`, Not Null): SMTP port range constraint (`1` to `65535`).
- **`smtp_secure`** (`BOOLEAN`, Not Null, Default `FALSE`): TLS option.
- **`smtp_user`** (`VARCHAR`, Not Null): SMTP auth username.
- **`smtp_pass`** (`VARCHAR`, Not Null): SMTP auth password (never exposed to API responses or logs).
- **`created_at`** (`TIMESTAMPTZ`, Not Null, Default `NOW()`).
- **`updated_at`** (`TIMESTAMPTZ`, Not Null, Default `NOW()`).

### Campaign → Sender Relationship
- **`campaigns.sender_id`** (`UUID`): Foreign key referencing `senders.id`.
- Enforces an `ON DELETE RESTRICT` constraint to prevent deleting a sender if referenced by campaigns.
- Nullable in the schema for backwards-compatibility with existing tests, but validated as **required** at the API controller layer when creating new campaigns.

### Ethereal Account Setup for Multiple Senders
For testing, multiple Ethereal SMTP accounts can be generated. In the verification tests (`npm run sender:test`), Nodemailer's `nodemailer.createTestAccount()` dynamically generates two distinct Ethereal SMTP credentials with separate usernames and passwords to verify isolated sending.

### Sender REST API Endpoints
All endpoints are protected under the `requireAuth` session check:
- `POST /senders` — Creates a new sender for the authenticated user.
- `GET /senders` — Lists senders belonging to the authenticated user.
- `GET /senders/:id` — Retrieves details of a specific sender owned by the user.
- `PATCH /senders/:id` — Updates details of a sender.
- `DELETE /senders/:id` — Deletes a sender. Rejects with HTTP 400 if actively referenced by campaigns.

### Sender Ownership & Security
- **Strict User Isolation**: All CRUD queries append `AND user_id = $userId` to ensure users cannot view, edit, or delete another user's senders.
- **Campaign Verification**: Prior to campaign creation or updates, the system queries PostgreSQL to ensure `sender_id` exists and belongs to the authenticated user.
- **Payload & Response Safety**: Sensitive parameters like `smtp_pass` are completely stripped from API responses, database logs, and BullMQ payloads. The background worker loads SMTP credentials directly from PostgreSQL by ID when a job runs.

### Worker Sender Selection & Transporter Caching
To optimize performance and reuse SMTP connections, Nodemailer transporters are cached in memory:
- **Transporter Cache**: Maps `sender.id` to a cached Nodemailer transporter and a SHA-256 hash of its SMTP credentials (`smtp_host`, `smtp_port`, `smtp_secure`, `smtp_user`, `smtp_pass`).
- **Cache Invalidation**: On every email send, the worker computes a SHA-256 hash of the retrieved sender credentials and compares it with the cached hash. If credentials changed (hash mismatch), the worker closes the old transporter using `transporter.close()` to release idle sockets, instantiates a new transporter, and updates the cache.

### Interaction with Core Features
- **Idempotency**: Retains protection normally. Duplicate job submissions for the same recipient-campaign are skipped instantly by the worker, ignoring sender settings.
- **Retries**: BullMQ retry mechanism remains intact. If SMTP connection or send fails, worker records a failure log, throws the error, and relies on BullMQ backoff policies.
- **Email Logs**: Appends a `sender_id` column to the `email_logs` table (nullable for backward compatibility), providing complete historical tracking of which sender dispatched each email.
- **Elasticsearch Indexing**: Extends indexing schemas for `EmailSearchDoc` to include safe fields: `senderId`, `senderEmail`, and `senderName`. Both scheduled campaigns and sent updates populate these fields.

### Verification & Testing
To execute the Multiple Senders integration suite:
```bash
npm run sender:test
```
This runs CRUD tests, validates API security constraints, simulates multi-sender enqueuing, and processes real deliveries with distinct Ethereal identities.


---

## Phase 9C: Minimum Send Delay Between Emails

### Overview
This phase introduces a configurable minimum delay (`EMAIL_SEND_DELAY_MS`) between consecutive outgoing emails. This ensures that the system coordinates email dispatches globally, spacing them out to prevent triggering spam filters or hitting mail server rate limits.

### Why Send Delay is Different
- **Concurrency** (`worker concurrency = 2`): Restricts the number of jobs being actively processed *at the exact same moment*.
- **Hourly Rate Limiting** (`hourly_limit = 5`): Limits the *maximum number of emails* sent by a campaign in a rolling 1-hour window.
- **Minimum Send Delay** (`EMAIL_SEND_DELAY_MS = 2000`): Enforces a *minimum spacing* (e.g., 2 seconds) between any two consecutive email sends globally (or across the worker pool). Even if 100 emails are ready and concurrency is 10, the system will not dispatch them faster than the configured spacing.

### Architecture and Shared Redis Spacing
To support safe multi-worker environments (e.g., scaling workers to multiple containers/machines), the minimum send delay is managed centrally in Redis:
- **Redis Key**: `email-send:global:last-send` stores the millisecond timestamp of the last successful email send reservation.
- **Atomic Lua Script**: When a worker is ready to send an email, it executes a Redis Lua script to check the last send time and reserve a slot:
  ```lua
  local last_send = tonumber(redis.call('GET', KEYS[1]) or '0')
  local now = tonumber(ARGV[1])
  local delay = tonumber(ARGV[2])
  if last_send == 0 or now - last_send >= delay then
    redis.call('SET', KEYS[1], tostring(now), 'EX', 3600)
    return 0
  else
    return last_send + delay - now
  end
  ```
  - If the delay window has passed, the script updates the key to the current timestamp and returns `0` (allowed).
  - If the delay window has not passed, it returns the remaining wait time (in milliseconds) without updating the key. This prevents "double-booking" or causing compound delay cascades when multiple workers check the delay.

### Rescheduling Strategy (No Busy Waiting)
Instead of blocking worker threads (e.g., `while(!allowed) { await sleep(...) }`), the worker leverages BullMQ's native delayed state:
1. The worker fetches the remaining delay (`waitMs`).
2. The worker calls `await job.moveToDelayed(Date.now() + waitMs, job.token)`.
3. The worker throws a `DelayedError()`.
This reschedules the job in BullMQ to be processed after `waitMs` has elapsed and releases the worker thread to process other jobs in the meantime. Throwing `DelayedError` tells BullMQ that the job was deliberately moved to delayed state, ensuring it is not counted as a job attempt failure.

### Interaction with Core Features
- **Idempotency & Hourly Rate Limiting**: The spacing check is executed **last**, immediately before the SMTP send. This ensures that duplicate jobs (skipped by idempotency) and rate-limited campaigns do not reserve or consume spacing slots.
- **Retries**: If an email send fails (triggers retry backoff), the slot is already consumed, but subsequent attempts will re-request a slot before actually sending, maintaining the required spacing.
- **Multi-Worker Behavior**: Thanks to the atomic Redis Lua script, multiple workers running in parallel are perfectly coordinated.

### Configuration
Exposed in the environment file:
- **`EMAIL_SEND_DELAY_MS`**: Configures the delay duration in milliseconds (default: `2000` ms). Must be a non-negative integer.
For test runs, `SEND_DELAY_TEST_MS` can be used as an environment override to use a shorter spacing (e.g. `500` ms) for faster test execution.

### Verification & Testing
To execute the Send Delay verification suite:
```bash
npm run send-delay:test
```
This runs 6 tests:
1. **Redis Atomicity Test**: Asserts that only one concurrent reservation succeeds, and others get the remaining wait time.
2. **Basic Timing Test**: Verifies that 3 sequential jobs are sent with spacing respect.
3. **Concurrent Worker Timing Test**: Verifies that spacing is maintained when 3 jobs are processed concurrently.
4. **Rate Limit + Send Delay Test**: Verifies that both constraints are independent.
5. **Retry + Send Delay Test**: Verifies that retried jobs respect spacing.
6. **Restart Test**: Verifies that spacing is maintained after worker pause/resume.

### Known Limitations
- The timing assertions inside tests allow a small scheduling tolerance (e.g., up to 100ms) to accommodate minor differences in OS execution speed and Redis response times.

---

## Phase 9E — Exact-Time Scheduling

### Architecture

```
POST /campaigns  { scheduled_at: "2024-12-01T09:00:00Z", ... }
        ↓
campaignController  ←── validates: future ISO timestamp, rejects past with HTTP 400
        ↓
createCampaignWithRecipients  (atomic PostgreSQL transaction)
        ↓
scheduleEmailJobs()           ←── Phase 9E core: one BullMQ delayed job per recipient
        ↓
BullMQ Queue in Redis         ←── job.delay = scheduledAt.getTime() - Date.now()
        ↓
[time passes — BullMQ/Redis promotes delayed job → waiting at exact scheduled_at]
        ↓
emailWorker picks up job
        ↓
idempotency check (email_logs) → rate-limit check → send-delay check → SMTP send
        ↓
email_logs.status = 'sent',  sent_at = NOW()
        ↓
Elasticsearch: status = 'sent',  sentAt = ...
```

**No cron. No `setInterval`. No polling.** BullMQ + Redis owns all waiting state.

### scheduled_at Semantics

| Value | Behaviour |
|---|---|
| Omitted / `null` | Enqueued immediately (delay = 0) |
| Valid future ISO 8601 string | Delayed until that UTC moment |
| Past or current timestamp | **HTTP 400** — rejected at controller level |
| Invalid / malformed string | **HTTP 400** — rejected at controller level |

### UTC / Timezone Handling

- API accepts any ISO 8601 string, including offsets: `"2024-01-15T10:00:00Z"` or `"2024-01-15T15:30:00+05:30"`.
- `new Date(raw)` converts to UTC JavaScript Date object.
- PostgreSQL stores `scheduled_at` as `TIMESTAMPTZ` (UTC).
- Delay arithmetic is pure UTC epoch milliseconds:
  ```
  delayMs = scheduledAt.getTime() - Date.now()
  delayMs = Math.max(0, delayMs)   // never negative
  ```
- **Clock skew**: API server and worker are assumed to share a reasonably synchronised clock (NTP). No distributed clock synchronisation is implemented.

### BullMQ Delay Calculation

```typescript
// src/services/schedulingService.ts
const rawDelayMs = scheduledAt ? scheduledAt.getTime() - Date.now() : 0;
const delayMs    = Math.max(0, rawDelayMs);   // clamp — never negative

const job = await emailQueue.add('send-email', { campaignId, recipientId }, { delay: delayMs });
// Logs: [Scheduler] Job <id> delayed until <ISO> (recipient=<id>)
```

- One delayed job per recipient (3 recipients → 3 separate delayed jobs).
- Job payload contains only `campaignId` + `recipientId`. No SMTP credentials, Slack tokens, or OAuth secrets are placed in the queue.

### Scheduled Execution Behaviour

| Condition | Behaviour |
|---|---|
| `scheduled_at` reached, rate capacity available, send-slot free | Email sent |
| `scheduled_at` reached, rate limit exhausted | Job re-delayed by Phase 7 logic |
| `scheduled_at` reached, minimum send delay active | Job re-delayed by Phase 9C logic |
| Worker stopped **before** `scheduled_at` | Redis retains delayed job; new worker processes after scheduled time |
| Worker stopped **after** `scheduled_at` | Job in `waiting` state; new worker processes immediately |
| API restarted (worker unaffected) | No impact — scheduling state lives in Redis, not in the API process |
| Campaign deleted after jobs enqueued | Worker fails to load campaign → 3 BullMQ retries → `failed` state; **no email sent** |

### Timing Tolerance

An email may arrive slightly **after** `scheduled_at` due to:
- BullMQ internal scheduler poll latency (~1 s)
- Worker concurrency queue
- SMTP roundtrip time (Ethereal ~1–3 s)

**Acceptable tolerance: 15 seconds.**

An email sent **before** `scheduled_at` is always a hard test failure.

### Idempotency

If the worker receives the same `campaignId + recipientId` pair twice (duplicate enqueue, retry, or restart):

```
SELECT id FROM email_logs WHERE campaign_id=$1 AND recipient_id=$2 AND status='sent'
→ found?  skip send immediately (no SMTP call)
→ missing? proceed with rate-limit → send-delay → SMTP
```

Business-level idempotency is enforced inside the worker, independent of BullMQ job IDs.

### Retry Behaviour

| Attempt | Outcome | email_logs |
|---|---|---|
| 1 | SMTP error | `failed` row inserted |
| 2 | SMTP error | `failed` row inserted |
| 3 | Success | `sent` row inserted; idempotency prevents any further send |

- BullMQ backoff: exponential, base 5 s, max 3 attempts.
- Failed jobs are retained in Redis (`removeOnFail: false`) for inspection in Bull Board.
- Successful jobs are removed (`removeOnComplete: true`) to conserve Redis memory.

### Restart Recovery

**Worker restart before `scheduled_at`:**
1. Job lives in `delayed` state in Redis.
2. Worker A stops — job is unaffected.
3. `scheduled_at` passes — BullMQ promotes job to `waiting`.
4. Worker B starts — picks up and processes the job.
5. Exactly one `sent` log in `email_logs`.

**Worker restart after `scheduled_at`:**
1. Job is in `waiting` state in Redis (already promoted).
2. Worker B starts — processes immediately.
3. Exactly one `sent` log.

**API restart (Redis and worker intact):**
- Scheduling state is in Redis — no re-enqueue needed.
- API restart has zero effect on pending scheduled jobs.

### Cancellation / Update Limitation

> ⚠️ **Known limitation (Phase 9E):** The system does not implement cancellation of BullMQ delayed jobs when a campaign is updated or deleted. If a campaign is deleted after `scheduleEmailJobs()` has run, the pending BullMQ job will still fire at `scheduled_at`. The worker will fail to load the campaign from PostgreSQL, log an error, and after 3 attempts the job will enter `failed` state. **No email is sent.** Safe cancellation (finding and removing the BullMQ job on campaign delete) is a future enhancement.

### Database Consistency

PostgreSQL is committed **before** BullMQ enqueue. A queue error is logged but does not roll back the campaign.

| State | What it means |
|---|---|
| DB committed + job enqueued | ✅ Normal |
| DB committed + job missing (queue error) | Campaign exists; job must be re-created manually |
| Job exists + campaign deleted | Worker fails safely after 3 attempts; no email sent |

### Observability Logs

```
[Scheduler] Scheduling campaign <id> for 3 recipient(s)
[Scheduler] scheduledAt=2024-12-01T09:00:00.000Z
[Scheduler] delayMs=300000
[Scheduler] Job <id> delayed until 2024-12-01T09:05:00.000Z (recipient=<id>)
```

Logs **never** contain: SMTP passwords · Slack tokens · webhook URLs · OAuth secrets · session secrets.

Bull Board at `http://localhost:5001/admin/queues` shows all jobs as **delayed** before `scheduled_at` and **completed** after successful send.

### Test Instructions

```bash
# Phase 9E — exact-time scheduling end-to-end (~60 s)
npm run scheduled-email:test

# Phase 9E — worker-restart recovery (~60 s)
npm run scheduled-recovery:test

# Override delay for faster runs (minimum ~5 s recommended)
SCHEDULE_TEST_DELAY_SECONDS=5 npm run scheduled-email:test
SCHEDULE_RECOVERY_DELAY_SECONDS=8 npm run scheduled-recovery:test
```

**`scheduled-email:test` verifies:**
1. Controller rejects past `scheduled_at` with HTTP 400
2. BullMQ job is in `delayed` state immediately after campaign creation
3. Job delay ≈ `scheduledAt - now` (±3 s tolerance)
4. Email sent at/after `scheduled_at` (never before)
5. `email_logs.status = 'sent'`, `sent_at >= scheduledAt`
6. Elasticsearch `status = 'sent'`, `sentAt` populated
7. Idempotency: re-enqueue same `campaignId + recipientId` → still only 1 sent log
8. Multiple recipients: all 3 get individual delayed jobs
9. Rate-limit interaction: `hourly_limit=1`, 3 recipients → 1 sent, 2 re-delayed

**`scheduled-recovery:test` verifies:**
1. Job is in `delayed` state after campaign creation
2. Job persists in Redis after Worker A stops
3. Job is available after `scheduled_at` passes
4. Worker B processes the job after restart
5. Exactly 1 `sent` log in `email_logs`
6. Elasticsearch `status = 'sent'`
7. Idempotency: no duplicate on re-enqueue post-send
