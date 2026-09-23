import "reflect-metadata";
import { Logger } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { join } from "node:path";
import { AppModule } from "./app.module";
import { EnvValidationError, loadApiEnv } from "./config/env";
import { findRepoRoot, readEnvFile } from "./config/env-file";
import { SafeExceptionFilter } from "./http/safe-exception.filter";

async function bootstrap(): Promise<void> {
  const root = findRepoRoot(__dirname);
  const env = loadApiEnv(process.env, readEnvFile(join(root, ".env")));
  const app = await NestFactory.create(AppModule.register(env), {
    logger: ["error", "warn", "log"],
  });
  app.setGlobalPrefix("api/v1");
  app.enableShutdownHooks();
  app.useGlobalFilters(new SafeExceptionFilter());
  await app.listen(env.API_PORT, env.BIND_HOST);
  Logger.log(`api listening on ${env.BIND_HOST}:${String(env.API_PORT)}`, "Api");
}

void bootstrap().catch((error: unknown) => {
  if (error instanceof EnvValidationError) {
    console.error(error.message);
  } else if (error instanceof Error) {
    console.error(`api startup failed: ${error.name}`);
  } else {
    console.error("api startup failed");
  }
  process.exit(1);
});
