import { Injectable, type OnModuleDestroy } from "@nestjs/common";
import { isAbsolute } from "node:path";
import {
  JobPersistenceService,
  MediaAssetStore,
  MockTextService,
  RuntimeStore,
  TextChainService,
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
    const textChain = new TextChainService(pool);
    const absoluteDir = env.MOCK_OBJECT_DIR && isAbsolute(env.MOCK_OBJECT_DIR) ? env.MOCK_OBJECT_DIR : null;
    const nonProduction = env.NODE_ENV !== "production";
    const mockImageEnabled = nonProduction && env.M3_MOCK_IMAGE_ENABLED && Boolean(absoluteDir);
    const mockAvEnabled = nonProduction && env.M3_MOCK_AV_ENABLED && Boolean(absoluteDir);
    return new StudioRuntime(pool,
      new StudioService(jobs, store, textChain, workspaceId, new MockTextService(pool), new MediaAssetStore(pool),
        mockImageEnabled, absoluteDir, mockAvEnabled), store);
  }

  async onModuleDestroy(): Promise<void> {
    await closePostgresPool(this.pool);
  }
}
