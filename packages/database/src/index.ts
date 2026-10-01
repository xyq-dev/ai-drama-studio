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
  type ScriptRevisionPage,
  type ScriptRevisionView,
  type StoryRevisionPage,
  type StoryRevisionView,
  type TextEntityKind,
  type TextAggregatePage,
  type TextAggregatePointers,
  type TextAggregateSummary,
  type SceneRevisionInput,
  type ShotRevisionInput,
} from "./text-chain";
export { type ScriptDependencyBinding, type ScriptDependencyConsumer } from "./script-dependencies";
export { MockTextService, type MockSceneSnapshot, type MockSceneSource,
  type MockShotSnapshot, type MockShotSource } from "./mock-text";

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

export {
  MediaAssetStore,
  type CreateMediaAssetInput,
  type MediaAssetRecord,
} from "./media-assets";
export {
  MOCK_MEDIA_JOB_KINDS,
  MOCK_MEDIA_ROUTES,
  isMockMediaJobKind,
  mockMediaRoute,
  type MockMediaJobKind,
} from "./mock-media-kinds";
export {
  assertFixedMockImageSnapshot,
  assertSyncActualCost,
  guardSynchronousMockImageCost,
  providerCostMatches,
  recordProviderActualCost,
  type ProviderActualCostInput,
  type StoredProviderCost,
} from "./mock-media-cost";
export {
  provisionMockAvProviders,
  resolveMockAvProvisionConfig,
  type MockAvProvisionConfig,
  type MockAvProvisionResult,
} from "./provision-mock-av";
export {
  provisionMockSmProviders,
  resolveMockSmProvisionConfig,
  type MockSmProvisionConfig,
  type MockSmProvisionResult,
} from "./provision-mock-sm";
