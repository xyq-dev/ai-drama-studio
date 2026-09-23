import "reflect-metadata";
import { Logger } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { join } from "node:path";
import { AppModule } from "./app.module";
import { EnvValidationError, loadWorkerEnv } from "./config/env";
import { findRepoRoot, readEnvFile } from "./config/env-file";
import { SafeExceptionFilter } from "./http/safe-exception.filter";
import { WORKER_BOOT_LOGS } from "./version";

async function bootstrap(): Promise<void> {
  const logger = new Logger("Worker");
  for (const line of WORKER_BOOT_LOGS) {
    logger.log(line);
  }
  const root = findRepoRoot(__dirname);
  const env = loadWorkerEnv(process.env, readEnvFile(join(root, ".env")));
  const app = await NestFactory.create(AppModule.register(env), {
    logger: ["error", "warn", "log"],
  });
  app.enableShutdownHooks();
  app.useGlobalFilters(new SafeExceptionFilter());
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
