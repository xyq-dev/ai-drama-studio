import { Inject, Injectable, type OnModuleDestroy } from "@nestjs/common";
import { checkPostgres, closePostgresPool, createPostgresPool, type PostgresPool } from "@ai-drama/database";
import type { WorkerEnv } from "../config/env";
import { WORKER_ENV } from "./tokens";

@Injectable()
export class PostgresHealth implements OnModuleDestroy {
  private readonly pool: PostgresPool;

  constructor(@Inject(WORKER_ENV) private readonly env: WorkerEnv) {
    this.pool = createPostgresPool({
      connectionString: env.DATABASE_URL,
      connectionTimeoutMs: env.HEALTH_CHECK_TIMEOUT_MS,
      statementTimeoutMs: env.HEALTH_CHECK_TIMEOUT_MS,
      queryTimeoutMs: env.HEALTH_CHECK_TIMEOUT_MS,
    });
  }

  check(): Promise<"ok" | "down"> {
    return checkPostgres(this.pool, this.env.HEALTH_CHECK_TIMEOUT_MS);
  }

  async onModuleDestroy(): Promise<void> {
    await closePostgresPool(this.pool);
  }
}
