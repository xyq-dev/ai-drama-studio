import { Inject, Injectable, type OnModuleDestroy } from "@nestjs/common";
import { checkPostgres, closePostgresPool, createPostgresPool, type PostgresPool } from "@ai-drama/database";
import type { ApiEnv } from "../config/env";
import { API_ENV } from "./tokens";

@Injectable()
export class PostgresHealth implements OnModuleDestroy {
  private readonly pool: PostgresPool;

  constructor(@Inject(API_ENV) private readonly env: ApiEnv) {
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
