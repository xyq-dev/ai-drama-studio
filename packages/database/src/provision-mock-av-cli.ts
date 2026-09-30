import { closePostgresPool, createPostgresPool } from "./index";
import { provisionMockAvProviders, resolveMockAvProvisionConfig } from "./provision-mock-av";

async function main(): Promise<void> {
  const config = resolveMockAvProvisionConfig(process.env);
  const pool = createPostgresPool({
    connectionString: config.databaseUrl,
    connectionTimeoutMs: 5_000,
    statementTimeoutMs: 10_000,
    queryTimeoutMs: 10_000,
  });
  try {
    const result = await provisionMockAvProviders(pool, config.workspaceId);
    process.stdout.write(
      `Mock AV providers video ${result.videoId} and audio ${result.audioId} are ${result.created ? "created" : "already present"} for workspace ${config.workspaceId}.\n`,
    );
  } finally {
    await closePostgresPool(pool);
  }
}

void main();
