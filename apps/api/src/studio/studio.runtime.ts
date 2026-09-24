import { Injectable, type OnModuleDestroy } from "@nestjs/common";
import {
  JobPersistenceService,
  RuntimeStore,
  closePostgresPool,
  createPostgresPool,
  type PostgresPool,
} from "@ai-drama/database";
import type { ApiEnv } from "../config/env";
import { StudioService } from "./studio.service";

@Injectable()
export class StudioRuntime implements OnModuleDestroy {
  readonly store: RuntimeStore;
  readonly service: StudioService;

  constructor(
    readonly pool: PostgresPool,
    service: StudioService,
    store: RuntimeStore,
  ) {
    this.service = service;
    this.store = store;
  }

  static async open(env: ApiEnv): Promise<StudioRuntime> {
    const pool = createPostgresPool({
      connectionString: env.DATABASE_URL,
      connectionTimeoutMs: env.HEALTH_CHECK_TIMEOUT_MS,
      statementTimeoutMs: 10_000,
      queryTimeoutMs: 10_000,
    });
    const store = new RuntimeStore(pool);
    const workspaceId = await store.requireActiveWorkspace(env.APP_WORKSPACE_ID);
    const jobs = new JobPersistenceService(pool);
    return new StudioRuntime(pool, new StudioService(jobs, store, workspaceId), store);
  }

  async onModuleDestroy(): Promise<void> {
    await closePostgresPool(this.pool);
  }
}
