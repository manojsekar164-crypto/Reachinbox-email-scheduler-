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

## Prompt 3: Phase 1 Database & Delivery Reliability Execution

**Date:** 2026-11-17T11:51:11+05:30
**Branch:** `feat/database-foundation`
**Prompt Content:**
```text
Phase 0 is completed.
The official GitHub repository is connected.
The feat/database-foundation branch has been
created and pushed successfully.

You must work exclusively on this branch.

Read:
- docs/PHASE_0_AUDIT.md
- docs/ANTIGRAVITY_WORKING_BRIEF.md
- docs/ANTIGRAVITY_PROMPTS.md
- docs/IMPLEMENTATION_LOG.md

Now execute the approved Phase 1 Database
and Delivery Reliability implementation prompt.

Preserve all existing data and functionality.

Do not modify the frontend.

Do not start Phase 2 automatically.
```

---

## Prompt 4: Stage 1 Database Migrations & Delivery Model Detailed Prompt

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

---

## Prompt 4: Phase 1 Migration Correction (Review Round 1)

**Date:** 2026-11-17T14:30:00+05:30
**Role:** Senior PostgreSQL Architect and Distributed Systems Engineer.
**Prompt Content:**
```text
Save the revised migration plan as: docs/PHASE_1_MIGRATION_CORRECTION.md
Place any corrected SQL migration files in the existing backend migration directory.
First inspect the current project structure and follow its existing naming convention.
Do not execute any migrations against PostgreSQL.
Do not delete or modify historical database records.
Do not commit or push these changes yet.
After creating the files, show me:
1. The complete revised migration plan.
2. Every file created or modified.
3. The corrected SQL.
4. Any risks or unresolved decisions.
```

---

## Prompt 5: Phase 1 Migration Correction (Review Round 2)

**Date:** 2026-11-17T15:00:00+05:30
**Role:** Senior PostgreSQL Architect and Database Security Engineer.
**Prompt Content:**
```text
Review docs/PHASE_1_MIGRATION_CORRECTION.md and address:
1. Migration 004 – Historical Duplicate Safety:
   Existing DB contains duplicate sent records for the same (campaign_id, recipient_id).
   Do not create a unique index on historical email_logs. Use email_deliveries as canonical.
2. Prevent Historical Campaign Rescheduling:
   Remove unsafe ELSE 'pending' from migration 007.
   Completed, sent, failed, terminated historical campaigns must not be auto-restarted.
   Sending, paused, unknown campaigns must be non-dispatchable (cancelled).
   Scheduled campaigns require valid future timestamp.
3. Protect Historical Records:
   Do not use ON DELETE CASCADE on historical attempts.
   Support soft delete or ON DELETE RESTRICT.
4. Recoverable Transactional Outbox:
   Support multi-worker claiming without race conditions (lease_expires_at, claim_owner).
5. Deterministic Attempt History:
   Tie-breaker for identical created_at. Clear stale last_error when sent.
6. Real PostgreSQL Verification:
   Execute migration against restored real PostgreSQL database; prove data preserved.
```

---

## Prompt 6: Phase 1 Final Safety Review (Round 3)

**Date:** 2026-11-17T15:20:00+05:30
**Role:** Senior Backend Architect, Database Security Engineer.
**Prompt Content:**
```text
Make the following four additional corrections before Phase 1 can be submitted:
1. Draft Campaign Dispatch Safety:
   Ensure pending deliveries belonging to draft campaigns cannot be claimed by any worker or recovery process.
   Require explicit campaign launch action. Add real PostgreSQL test proving draft deliveries are never dispatched.
2. Unknown Historical Email Log States:
   Detect ambiguous historical log states (queued, processing, attempting, unknown).
   Map to non-dispatchable 'unknown'. Never blindly resend. Test mixed statuses (sent+failed, failed-only, unknown-only, no-log).
3. Complete Historical SMTP Metadata Preservation:
   Preserve sender_id, sent_at, error_message from email_logs.
   Unavailable fields (smtp_message_id, smtp_response_code, error_classification) remain NULL without fabricating fake codes/IDs.
4. Migration Rollback & Future Scheduled Delivery Recovery:
   Distinguish in-transaction rollback from post-commit rollback.
   Document Stage 2 recovery for legitimate future scheduled deliveries into BullMQ with deduplication.
   Document cutover and worker shutdown/restart ordering.
```

---

## Prompt 7: Senior Backend Engineer Operational Guidelines & Engineering Standards

**Date:** 2026-11-17T15:43:00+05:30
**Role:** Senior Backend Engineer.
**Prompt Content:**
```text
You are acting as a Senior Backend Engineer working on the existing ReachInbox email scheduling platform.
Your responsibility is to implement reliable, maintainable and testable improvements in the existing codebase.

### Engineering standards
1. Understand the existing implementation before modifying it.
2. Reuse working components and established project conventions.
3. Make targeted changes. Avoid unnecessary rewrites and large refactors.
4. Implement actual application functionality, not documentation-only solutions.
5. Use PostgreSQL as the authoritative source of delivery state.
6. Use Redis and BullMQ for persistent job scheduling and processing.
7. Never use cron, crontab, node-cron, Agenda or cron-based scheduling.
8. Never fabricate SMTP success, delivery metrics or test results.
9. Never blindly retry an email with an uncertain SMTP outcome.
10. Never execute migrations or destructive tests against the original reachinbox database.

### Git safety
- Work on the existing feature branch.
- Preserve all existing user changes.
- Never run destructive Git commands such as reset --hard, clean or force push.
- Do not overwrite unrelated modified files.
- Do not commit or push without explicit approval.

### Implementation workflow
For every task:
1. Inspect the relevant source files.
2. Identify the specific defect or requirement.
3. Implement only the requested scope.
4. Run appropriate tests.
5. Review the Git diff.
6. Report modified files, test results and unresolved issues.

Stop after completing each requested batch. Do not automatically begin the next batch.
Prioritise correctness, reliability and delivery speed without compromising data safety.
```
