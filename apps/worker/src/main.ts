import "reflect-metadata";
import { Logger } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { isAbsolute, join } from "node:path";
import { AppModule } from "./app.module";
import { sampleVideoGenerationEnabled,realMediaAccessAllowed } from "@ai-drama/contracts";
import { EnvValidationError, loadWorkerEnv } from "./config/env";
import { findRepoRoot, readEnvFile } from "./config/env-file";
import { SafeExceptionFilter } from "./http/safe-exception.filter";
import { startQueueRuntime } from "./runtime/start-runtime";
import { WORKER_BOOT_LOGS } from "./version";
import { ServerRealMediaRuntime } from "@ai-drama/providers";
import { workerComposePolicy } from "./runtime/media-runtime-policy";

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
  const realAccessAllowed=realMediaAccessAllowed({nodeEnv:env.NODE_ENV,siteAuthConfigured:env.REAL_MEDIA_SITE_AUTH_CONFIGURED,
    allowProduction:env.REAL_MEDIA_ENV?.REAL_MEDIA_ALLOW_PRODUCTION==="true"});
  const realRuntime = env.REAL_MEDIA_WORKSPACE_ID && env.REAL_MEDIA_ENV
    ? new ServerRealMediaRuntime(env.REAL_MEDIA_WORKSPACE_ID, env.REAL_MEDIA_ENV,
      realAccessAllowed) : undefined;
  const composePolicy=workerComposePolicy({production:env.NODE_ENV==="production",localEnabled:env.M4_LOCAL_COMPOSE_ENABLED,
    episodeEnabled:env.M4_LOCAL_EPISODE_COMPOSE_ENABLED,mockDirectoryReady:directoryReady,workDirectoryReady:Boolean(composeWorkDir),
    objectDirectoryReady:Boolean(composeObjectDir),realAccessAllowed,receiptReady:Boolean(realRuntime?.receiptCipher),s3Ready:Boolean(env.REAL_MEDIA_S3)});
  const composeAllowed=composePolicy.mockCompose;
  const realComposeAllowed=composePolicy.realCompose;
  if (env.M4_VOICE_COMPOSE_FONT_PATH && !isAbsolute(env.M4_VOICE_COMPOSE_FONT_PATH)) throw new EnvValidationError(["M4_VOICE_COMPOSE_FONT_PATH"]);
  const runtime = await startQueueRuntime({
    characterReferenceGate:env.M3_CHARACTER_REFERENCE_GATE,
    nodeEnv:env.NODE_ENV,realMediaSiteAuthConfigured:env.REAL_MEDIA_SITE_AUTH_CONFIGURED,
    realMediaAllowProduction:env.REAL_MEDIA_ENV?.REAL_MEDIA_ALLOW_PRODUCTION==="true",
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
    localComposeEnabled: composeAllowed || realComposeAllowed,
    episodeComposeEnabled: composePolicy.episodeCompose,
    composeWorkDir, composeObjectDir,
    composePythonBin: env.M4_COMPOSE_PYTHON,
    composePythonPath: join(root, "services", "media-worker", "src"),
    composeHoldBeforeCommitMs: composeAllowed ? env.M4_COMPOSE_HOLD_BEFORE_COMMIT_MS : 0,
    composeLeaseMs: composeAllowed ? env.M4_COMPOSE_LEASE_MS : 30_000,
    composeFailInsideCommit: composeAllowed && env.M4_COMPOSE_FAIL_INSIDE_COMMIT,
    ...(realRuntime ? { realMediaRuntime: realRuntime } : {}),
    ...(env.REAL_MEDIA_S3 ? { realMediaS3: env.REAL_MEDIA_S3 } : {}),
    storageSettingsEnvironment: env,
    ...(env.REAL_MEDIA_WORKSPACE_ID ? { storageWorkspaceId: env.REAL_MEDIA_WORKSPACE_ID } : {}),
    voiceComposeEnabled: realComposeAllowed,
    ...(env.M4_VOICE_COMPOSE_FONT_PATH ? { voiceComposeFontPath: env.M4_VOICE_COMPOSE_FONT_PATH } : {}),
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
