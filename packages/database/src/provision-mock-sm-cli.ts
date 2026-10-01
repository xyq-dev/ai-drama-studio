import { closePostgresPool, createPostgresPool } from "./index";
import { provisionMockSmProviders, resolveMockSmProvisionConfig } from "./provision-mock-sm";

async function main(): Promise<void> {
  const config = resolveMockSmProvisionConfig(process.env);
  const pool = createPostgresPool({
    connectionString: config.databaseUrl,
    connectionTimeoutMs: 5_000,
    statementTimeoutMs: 10_000,
    queryTimeoutMs: 10_000,
  });
  try {
    const result = await provisionMockSmProviders(pool, config.workspaceId);
    process.stdout.write(
      `Mock subtitle provider ${result.subtitleId} and music provider ${result.musicId} are ${result.created ? "created" : "already present"} for workspace ${config.workspaceId}.\n`,
    );
  } finally {
    await closePostgresPool(pool);
  }
}

void main();
