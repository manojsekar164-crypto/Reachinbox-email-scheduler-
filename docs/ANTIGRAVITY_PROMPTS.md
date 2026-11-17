# ANTIGRAVITY PROMPT LOG

**Project:** ReachInbox — Intelligent Email Delivery Platform  
**Repository:** `https://github.com/manojsekar164-crypto/Reachinbox-email-scheduler-.git`  
**Tracking Document:** Records all high-level instructions, constraints, and prompts provided during the development and hardening lifecycle.

---

## Prompt 1: Phase 0 Audit & Repository Assessment

**Date:** 2026-11-17T11:13:26+05:30  
**Role:** Senior Backend Architect, PostgreSQL Engineer and Distributed Systems Engineer.  
**Prompt Content:**
```text
ROLE:
Act as a Senior Backend Architect, PostgreSQL Engineer
and Distributed Systems Engineer.

PROJECT:
ReachInbox - Intelligent Email Delivery Platform.

CONTEXT:
This is my previously developed full-stack project.
I am continuing from the existing source code.

I do NOT want a new application.
I do NOT want the existing architecture replaced.

Your responsibility is to understand the existing
codebase and prepare it for controlled development.

MANDATORY CONSTRAINTS:

1. ABSOLUTELY NO CRON JOBS.
2. No crontab, node-cron, agenda or cron libraries.
3. Use BullMQ delayed jobs for scheduling.
4. PostgreSQL must be the permanent source of truth.
5. Redis and BullMQ must persist future jobs.
6. After a restart, pending jobs must continue.
7. Already-sent emails must never be blindly resent.
8. Every recipient delivery must have idempotency protection.
9. Do not fake SMTP success.
10. Implement shared sender-level rate limiting.
11. Support configurable worker concurrency.
12. Minimum email sending delay must be configurable.
13. Slack notifications must be real.
14. Google OAuth must be real.
15. Preserve existing working features.

EXISTING TECH STACK:

Frontend:
- React
- TypeScript
- Vite
- Tailwind CSS

Backend:
- Node.js
- Express
- TypeScript

Infrastructure:
- PostgreSQL
- Redis
- BullMQ
- Elasticsearch
- Nodemailer
- Ethereal SMTP
- Google OAuth
- Slack OAuth
- Docker Compose

CURRENT TASK: PHASE 0 AUDIT

Inspect the COMPLETE repository.

Examine:
1. Existing folder structure.
2. PostgreSQL schema and migrations.
3. Database transaction handling.
4. Campaign APIs.
5. Scheduling implementation.
6. BullMQ queue configuration.
7. Email workers.
8. Redis rate limiting.
9. Minimum sending delay.
10. Idempotency implementation.
11. SMTP service.
12. Slack integration.
13. Google authentication.
14. Elasticsearch indexing.
15. Bull Board.
16. Docker Compose.
17. Existing backend tests.
18. README instructions.

Identify all incomplete assignment requirements.

For every finding, provide:
- Existing file.
- Current implementation.
- Problem.
- Risk.
- Proposed solution.
- Test required.

Run safe baseline build and test commands.

IMPORTANT:
DO NOT MODIFY ANY FILE.
DO NOT CREATE MIGRATIONS.
DO NOT DELETE ANY CODE.
DO NOT REWRITE EXISTING SERVICES.

OUTPUT:
Create a detailed audit report at:
docs/PHASE_0_AUDIT.md

Also update:
docs/IMPLEMENTATION_LOG.md

Record:
- Audit date and time.
- Existing branch and commit.
- Commands executed.
- Actual test results.
- Outstanding issues.

At the end, recommend the exact
Phase 1 database implementation plan.

Wait for my approval before modifying
the application.
```

---

## Prompt 2: Phase 0 Completion & Source of Truth Establishment

**Date:** 2026-11-17T11:33:48+05:30  
**Prompt Content:**
```text
PHASE 0 IS COMPLETE.

I have reviewed and accepted the audit report:
docs/PHASE_0_AUDIT.md

Now establish the official GitHub source of truth
BEFORE implementing Phase 1.

OFFICIAL GITHUB REPOSITORY:
https://github.com/manojsekar164-crypto/Reachinbox-email-scheduler-.git

GIT RULES:
1. This repository is the canonical source of truth.
2. Preserve genuine Git history.
3. Inspect existing remote branches and commits.
4. Commit every verified development milestone.
5. Push each completed milestone.
6. Keep main stable and submission-ready.
7. Never force-push.
8. Never commit secrets, tokens or .env files.
9. Update README.md after verified feature completion.
10. Maintain ANTIGRAVITY_PROMPTS.md.
11. Maintain IMPLEMENTATION_LOG.md with actual test results.
12. Never rewrite the entire application unnecessarily.
13. Use feature branches for development.
14. Preserve existing working functionality.
15. Never push unverified changes.

Before pushing:
- Inspect git status.
- Inspect the remote branch.
- Check for exposed credentials.
- Check .gitignore.
- Preserve existing remote commits.
- Never overwrite remote history.

Create documentation:
docs/ANTIGRAVITY_PROMPTS.md
docs/IMPLEMENTATION_LOG.md

Record Phase 0 as completed.

IMPORTANT:
The uploaded source archive did not contain a .git
repository. Do not invent previous commit history.
If remote history exists, reconcile it safely.

After setup, report:
- Current branch.
- Remote URL.
- Latest commit.
- Working tree status.
- Whether the baseline was pushed.

DO NOT IMPLEMENT DATABASE CHANGES YET.
Wait for Phase 1 instructions.
```


---

## Prompt 4: Stage 1 Database Migrations & Delivery Model Execution

**Date:** 2026-11-17T12:02:20+05:30  
**Branch:** `feat/database-foundation`  
**Working Directory:** `D:\Devops projects\ReachInbox-canonical`  
**Prompt Content:**
```text
# REACHINBOX — PHASE 1 IMPLEMENTATION

ROLE:
You are a Senior PostgreSQL Architect,
Database Security Engineer and Distributed
Systems Engineer.

PROJECT:
ReachInbox — Intelligent Email Delivery Platform.

REPOSITORY:
https://github.com/manojsekar164-crypto/Reachinbox-email-scheduler-.git

CURRENT BRANCH:
feat/database-foundation

CURRENT BASELINE:
47c7ada

WORKING DIRECTORY:
D:\Devops projects\ReachInbox-canonical

--------------------------------------------------
1. FIRST READ ALL PROJECT DOCUMENTATION
--------------------------------------------------

Read these files completely:

docs/PHASE_0_AUDIT.md
docs/ANTIGRAVITY_WORKING_BRIEF.md
docs/ANTIGRAVITY_PROMPTS.md
docs/IMPLEMENTATION_LOG.md
README.md
backend/README.md

Understand the entire existing backend before
making any modifications.

The Phase 0 audit identified 18 findings.

Use the audit as the implementation reference.

Do not rebuild the existing application.

--------------------------------------------------
2. OFFICIAL DEVELOPMENT ROADMAP
--------------------------------------------------

We are following this exact order:

Stage 0: Existing project audit
Stage 1: Database migrations and delivery model
Stage 2: Transactional outbox and queue persistence
Stage 3: Idempotency and configurable workers
Stage 4: Rate limiting and minimum delay
Stage 5: SMTP and Slack integration
Stage 6: Elasticsearch and Google OAuth verification
Stage 7: Preflight and delivery forecast
Stage 8: Sender health monitor
Stage 9: Failure and recovery centre
Stage 10: AI Copilot
Stage 11: Frontend integration
Stage 12: Testing, README, GitHub and video

CURRENT TASK:
Stage 1 ONLY.

Do not automatically begin Stage 2.

--------------------------------------------------
3. NON-NEGOTIABLE CONSTRAINTS
--------------------------------------------------

ABSOLUTELY NO CRON JOBS.

Prohibited:
- OS cron
- crontab
- node-cron
- agenda
- Any cron-based scheduling library

Scheduling must use BullMQ delayed jobs or
a compliant persistent DB/Redis scheduler.

PostgreSQL must remain the permanent
source of truth.

Future scheduled jobs must survive restarts.

Already-sent emails must never be blindly
restarted or sent again.

Maintain per-delivery idempotency.

Never fake SMTP success.

Never delete existing working functionality.

Never reset or drop existing production data.

Never commit secrets or .env files.

--------------------------------------------------
4. STAGE 1 IMPLEMENTATION
--------------------------------------------------

OBJECTIVE:

Build a reliable database foundation that
supports individual email delivery tracking,
historical data preservation and future
distributed worker processing.

A. MIGRATION VERSION TRACKING
B. EMAIL DELIVERY DATA MODEL
C. DELIVERY STATUS MODEL
D. EMAIL ATTEMPT HISTORY
E. TRANSACTIONAL OUTBOX SCHEMA
F. HISTORICAL DATA BACKFILL
G. SMTP CREDENTIAL ENCRYPTION
H. DATABASE TYPE CONSISTENCY

--------------------------------------------------
5. DATABASE SAFETY REQUIREMENTS
--------------------------------------------------
6. TEST REQUIREMENTS
--------------------------------------------------
7. TEST AND BUILD
--------------------------------------------------
8. DOCUMENTATION
--------------------------------------------------
9. GIT REQUIREMENTS
--------------------------------------------------
10. DEFINITION OF DONE
--------------------------------------------------
FINAL REPORT REQUIRED

STOP AFTER PHASE 1.
WAIT FOR EXPLICIT APPROVAL BEFORE STAGE 2.
```
