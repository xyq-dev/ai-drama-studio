import "reflect-metadata";
import { Logger } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { isAbsolute, join } from "node:path";
import { AppModule } from "./app.module";
import { sampleVideoGenerationEnabled } from "@ai-drama/contracts";
import { EnvValidationError, loadWorkerEnv } from "./config/env";
import { findRepoRoot, readEnvFile } from "./config/env-file";
import { SafeExceptionFilter } from "./http/safe-exception.filter";
import { startQueueRuntime } from "./runtime/start-runtime";
import { WORKER_BOOT_LOGS } from "./version";

async function bootstrap(): Promise<void> {
  const logger = new Logger("Worker");
  for (const line of WORKER_BOOT_LOGS) {
    logger.log(line);
  }
  const root = findRepoRoot(__dirname);
  const env = loadWorkerEnv(process.env, readEnvFile(join(root, ".env")));
  const mockObjectDir = env.NODE_ENV === "production" ? undefined : env.MOCK_OBJECT_DIR;
  const directoryReady = Boolean(mockObjectDir && isAbsolute(mockObjectDir));
  const composeWorkDir = env.M4_COMPOSE_WORK_DIR && isAbsolute(env.M4_COMPOSE_WORK_DIR) ? env.M4_COMPOSE_WORK_DIR : undefined;
  const composeObjectDir = env.M4_COMPOSE_OBJECT_DIR && isAbsolute(env.M4_COMPOSE_OBJECT_DIR) ? env.M4_COMPOSE_OBJECT_DIR : undefined;
  const composeAllowed = env.NODE_ENV !== "production" && env.M4_LOCAL_COMPOSE_ENABLED && directoryReady && Boolean(composeWorkDir && composeObjectDir);
  const episodeComposeAllowed = env.NODE_ENV !== "production" && env.M4_LOCAL_COMPOSE_ENABLED && env.M4_LOCAL_EPISODE_COMPOSE_ENABLED && Boolean(composeWorkDir && composeObjectDir);
  const runtime = await startQueueRuntime({
    databaseUrl: env.DATABASE_URL, redisUrl: env.REDIS_URL, mockObjectDir,
    mockImageEnabled: env.NODE_ENV !== "production" && env.M3_MOCK_IMAGE_ENABLED && directoryReady,
    mockAvEnabled: env.NODE_ENV !== "production" && env.M3_MOCK_AV_ENABLED && directoryReady,
    mockSampleVideoEnabled: sampleVideoGenerationEnabled({
      nodeEnv: env.NODE_ENV,
      sampleFlag: env.M4_MOCK_SAMPLE_VIDEO_ENABLED,
      avFlag: env.M3_MOCK_AV_ENABLED,
      directoryReady,
    }),
    mockSmEnabled: env.NODE_ENV !== "production" && env.M3_MOCK_SUBTITLE_MUSIC_ENABLED && directoryReady,
    localComposeEnabled: composeAllowed,
    episodeComposeEnabled: episodeComposeAllowed,
    composeWorkDir, composeObjectDir,
    composePythonBin: env.M4_COMPOSE_PYTHON,
    composePythonPath: join(root, "services", "media-worker", "src"),
    composeHoldBeforeCommitMs: composeAllowed ? env.M4_COMPOSE_HOLD_BEFORE_COMMIT_MS : 0,
    composeLeaseMs: composeAllowed ? env.M4_COMPOSE_LEASE_MS : 30_000,
    composeFailInsideCommit: composeAllowed && env.M4_COMPOSE_FAIL_INSIDE_COMMIT,
  });
  const app = await NestFactory.create(AppModule.register(env, runtime.status), {
    logger: ["error", "warn", "log"],
  });
  app.enableShutdownHooks();
  app.useGlobalFilters(new SafeExceptionFilter());
  process.once("SIGTERM", () => {
    void runtime.shutdown();
  });
  process.once("SIGINT", () => {
    void runtime.shutdown();
  });
  await app.listen(env.WORKER_HEALTH_PORT, env.BIND_HOST);
  logger.log(`worker health listening on ${env.BIND_HOST}:${String(env.WORKER_HEALTH_PORT)}`);
}

void bootstrap().catch((error: unknown) => {
  if (error instanceof EnvValidationError) {
    console.error(error.message);
  } else if (error instanceof Error) {
    console.error(`worker startup failed: ${error.name}`);
  } else {
    console.error("worker startup failed");
  }
  process.exit(1);
});
