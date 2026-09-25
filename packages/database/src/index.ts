import { Pool, type PoolClient } from "pg";

export {
  runMigrations,
  type MigrationClient,
  type MigrationPool,
  type MigrationResult,
} from "./migrations";
export {
  JobPersistenceService,
  PersistenceError,
  type AcquiredJob,
  type CreateWorkflowJobInput,
  type CreatedWorkflowJob,
  type IdempotencyScope,
  type ManualRetryInput,
  type ProviderEventInput,
  type QueueJobInput,
} from "./job-service";
export {
  RuntimeStore,
  insertProject,
  requestHash,
  type DomainEventView,
  type ExecutionContext,
  type ExpiredLeaseRow,
  type JobView,
  type OutboxDispatchRow,
  type ProjectRecord,
  type WorkflowView,
} from "./runtime-store";
export {
  TextChainService,
  type EpisodeSummary,
  type RevisionCreated,
  type ReviewTransitioned,
  type StoryRevisionPage,
  type StoryRevisionView,
} from "./text-chain";

export interface PostgresPoolOptions {
  connectionString: string;
  connectionTimeoutMs: number;
  statementTimeoutMs: number;
  queryTimeoutMs: number;
}

export interface PostgresQueryClient {
  query(sql: string, values?: unknown[]): Promise<unknown>;
}

export interface PostgresPool extends PostgresQueryClient {
  connect(): Promise<PoolClient>;
  end(): Promise<void>;
  totalCount: number;
}

const HEALTH_SQL = "SELECT 1";

export function createPostgresPool(options: PostgresPoolOptions): PostgresPool {
  return new Pool({
    connectionString: options.connectionString,
    connectionTimeoutMillis: options.connectionTimeoutMs,
    statement_timeout: options.statementTimeoutMs,
    query_timeout: options.queryTimeoutMs,
    max: 4,
    idleTimeoutMillis: 10_000,
  });
}

export async function checkPostgres(
  client: PostgresQueryClient,
  timeoutMs: number,
): Promise<"ok" | "down"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      client.query(HEALTH_SQL),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error("timeout"));
        }, timeoutMs);
      }),
    ]);
    return "ok";
  } catch {
    return "down";
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

export async function closePostgresPool(pool: PostgresPool): Promise<void> {
  await pool.end();
}
