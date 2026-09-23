import "reflect-metadata";
import { Logger } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { join } from "node:path";
import { AppModule } from "./app.module";
import { EnvValidationError, loadAdapterEnv } from "./config/env";
import { findRepoRoot, readEnvFile } from "./config/env-file";

async function bootstrap(): Promise<void> {
  const root = findRepoRoot(__dirname);
  const env = loadAdapterEnv(process.env, readEnvFile(join(root, ".env")));
  const app = await NestFactory.create(AppModule.register(env), {
    logger: ["error", "warn", "log"],
  });
  app.enableShutdownHooks();
  await app.listen(env.COMFYUI_ADAPTER_PORT, env.BIND_HOST);
  Logger.log(
    `comfyui-adapter stub listening on ${env.BIND_HOST}:${String(env.COMFYUI_ADAPTER_PORT)}`,
    "ComfyuiAdapter",
  );
}

void bootstrap().catch((error: unknown) => {
  if (error instanceof EnvValidationError) {
    console.error(error.message);
  } else if (error instanceof Error) {
    console.error(`comfyui-adapter startup failed: ${error.name}`);
  } else {
    console.error("comfyui-adapter startup failed");
  }
  process.exit(1);
});
