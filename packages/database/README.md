# @ai-drama/database

M1-B adds the minimal PostgreSQL persistence model for workspace-scoped projects,
workflow/job recovery, attempts, transactional dispatch outbox, replayable domain
events, idempotency, provider event deduplication, and cost audit facts.

This package does not open a connection when imported. Applications create and close
the pool in their lifecycle. Apply versioned migrations with `DATABASE_URL=... pnpm
--filter @ai-drama/database migrate`; applied SQL is checksummed and cannot be edited.
