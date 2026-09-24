# @ai-drama/database

M1-B owns the durable PostgreSQL persistence/job core: Workspace/Project scope,
WorkflowRun/GenerationJob orchestration, attempts, leases, transactional dispatch
outbox + DomainEvent writes, API idempotency, provider-event deduplication, and cost
lineage.

The package includes a Prisma schema for the accepted M1-B model and a checked-in SQL
migration under `prisma/migrations`. Important database-only guarantees (CHECKs,
partial indexes, composite foreign keys, outbox identity triggers) remain explicit in
the migration even when Prisma cannot express them directly.

Commands:

```sh
DATABASE_URL=... pnpm --filter @ai-drama/database prisma:validate
DATABASE_URL=... pnpm --filter @ai-drama/database prisma:generate
DATABASE_URL=... pnpm --filter @ai-drama/database migrate
DATABASE_URL=... pnpm --filter @ai-drama/database integration
```

`migrate` takes one PostgreSQL connection for the advisory lock and all migration
transactions. Applied migration checksums are recorded and later edits are rejected.
The integration suite requires an isolated PostgreSQL database and resets its public
schema; never point it at production.

Key integrity rules in the migration:

- `workflow_run(project_id, created_at)` supports run history.
- `generation_job(state, next_run_at)` and the partial lease index support recovery.
- `dispatch_outbox(job_id, dispatch_seq)` makes dispatch generations unique.
- `job_attempt(generation_job_id, attempt_no)` makes attempts monotonic per job.
- ProviderEvent has an exact composite FK to the attempt/config/request tuple.
- CostLedger has composite FKs that keep project/job/attempt lineage consistent.
- Workspace-scoped parent/child relationships use composite foreign keys where needed.
