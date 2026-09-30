import { closePostgresPool, createPostgresPool } from "./index";
import { provisionMockMediaProvider, resolveMockMediaProvisionConfig } from "./provision-mock-media";

async function main(): Promise<void> {
  const config = resolveMockMediaProvisionConfig(process.env);
  const pool = createPostgresPool({
    connectionString: config.databaseUrl,
    connectionTimeoutMs: 5_000,
    statementTimeoutMs: 10_000,
    queryTimeoutMs: 10_000,
  });
  try {
    const result = await provisionMockMediaProvider(pool, config.workspaceId);
    process.stdout.write(
      `Mock image provider ${result.id} is ${result.created ? "created" : "already present"} for workspace ${config.workspaceId}.\n`,
    );
  } finally {
    await closePostgresPool(pool);
  }
}

void main();
