import { Pool } from "pg";
export { runMigrations, type MigrationClient, type MigrationPool, type MigrationResult } from "./migrations";

export interface PostgresPoolOptions {
  connectionString: string;
  connectionTimeoutMs: number;
  statementTimeoutMs: number;
  queryTimeoutMs: number;
}

export interface PostgresQueryClient {
  query(sql: string): Promise<unknown>;
}

export interface PostgresPool extends PostgresQueryClient {
  connect(): Promise<import("pg").PoolClient>;
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
