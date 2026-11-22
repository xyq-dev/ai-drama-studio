// Isolated admin fixture for T-ENG-ADMIN-AI-MODELS-AND-WRITING.
// Real site login + admin HTTP + encrypted temporary vaults. No application DB.
// Connection tests use an in-process mock probe only; all outbound fetch is forbidden.
import { createRequire } from "node:module";
import { chmod, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

if (process.env.ADMIN_AI_MODELS_ISOLATED !== "local-temporary-storage") {
  console.error("Explicit local-temporary-storage isolated flag required.");
  process.exit(1);
}
const root = resolve(fileURLToPath(new URL("../", import.meta.url)));
const require = createRequire(join(root, "apps/api/package.json"));
require("reflect-metadata");
const { Module } = require("@nestjs/common");
const { NestFactory } = require("@nestjs/core");
const { loadApiEnv } = require(join(root, "apps/api/dist/config/env.js"));
const { adminBootstrap } = require(join(root, "apps/api/dist/admin/admin-bootstrap.js"));
const { AdminModelsService } = require(join(root, "apps/api/dist/admin/admin-models.service.js"));
const { AdminModelsController, ADMIN_MODELS_SERVICE } = require(
  join(root, "apps/api/dist/admin/admin-models.controller.js"),
);
const { FeatureConfigVault, featureVaultPath } = require(
  join(root, "apps/api/dist/admin/feature-config-vault.js"),
);
const { FeatureUsageStore } = require(join(root, "apps/api/dist/admin/feature-usage-store.js"));
const { FeatureConfigService } = require(
  join(root, "apps/api/dist/admin/feature-config.service.js"),
);
const { FeatureConfigController, FEATURE_CONFIG_SERVICE } = require(
  join(root, "apps/api/dist/admin/feature-config.controller.js"),
);
const { setAdminResponseHeaders } = require(join(root, "apps/api/dist/admin/admin-auth.js"));
const { AuthModule } = require(join(root, "apps/api/dist/auth/auth.module.js"));
const { SiteAuth } = require(join(root, "apps/api/dist/auth/site-auth.js"));
const { hashPassword } = require(join(root, "apps/api/dist/auth/password-hash.js"));

const password = process.env.ADMIN_MODELS_TEST_PASSWORD;
if (!password || password.length < 16) {
  console.error("ADMIN_MODELS_TEST_PASSWORD (test-only, 16+ characters) is required.");
  process.exit(1);
}
const directory = process.env.ADMIN_AI_MODELS_RUNTIME_DIR;
if (!directory) {
  console.error("ADMIN_AI_MODELS_RUNTIME_DIR is required.");
  process.exit(1);
}
const origin = process.env.SITE_AUTH_PUBLIC_ORIGIN || "http://127.0.0.1:3822";
const port = Number(process.env.ADMIN_AI_MODELS_API_PORT || "3843");
await mkdir(directory, { recursive: true });
await chmod(directory, 0o700);

globalThis.fetch = async () => {
  throw new Error("Isolated fixture forbids all outbound fetches.");
};

function isolatedMockProbe() {
  return async (input) => {
    if (typeof input?.apiKey === "string" && /FAILPROBE/i.test(input.apiKey)) {
      return { ok: false, message: "隔离预览模拟：供应商拒绝了这次检测。" };
    }
    return {
      ok: true,
      message: "隔离预览模拟：连接检测已通过。",
      usage: { status: "present", amount: 1, unit: "request" },
    };
  };
}

const passwordHash = await hashPassword(password, {
  log2N: 15,
  r: 8,
  p: 1,
  saltBytes: 16,
  keyBytes: 32,
});
const env = loadApiEnv({
  NODE_ENV: "test",
  DATABASE_URL: "postgresql://unused:unused@127.0.0.1:1/no_database",
  REDIS_URL: "redis://127.0.0.1:1",
  S3_ENDPOINT: "http://127.0.0.1:1",
  S3_REGION: "test",
  S3_BUCKET: "unused",
  S3_ACCESS_KEY_ID: "unused",
  S3_SECRET_ACCESS_KEY: "unused",
  APP_WORKSPACE_ID: "11111111-1111-4111-8111-111111111111",
  MODEL_ADMIN_ENABLED: "true",
  MODEL_ADMIN_MASTER_KEY: process.env.MODEL_ADMIN_MASTER_KEY,
  MODEL_ADMIN_CONFIG_PATH: join(directory, "models.enc"),
  SITE_AUTH_ENABLED: "true",
  SITE_AUTH_USERNAME: process.env.SITE_AUTH_USERNAME || "admin",
  SITE_AUTH_PUBLIC_ORIGIN: origin,
  SITE_AUTH_PASSWORD_HASH: passwordHash,
});
const bootstrap = adminBootstrap(env);
const backend = await AdminModelsService.open(env, bootstrap, async () => true);
const featureVault = await FeatureConfigVault.open({
  path: featureVaultPath(bootstrap.path),
  masterKey: bootstrap.masterKey,
});
const featureConfig = await FeatureConfigService.open({
  vault: featureVault,
  usage: new FeatureUsageStore(join(directory, "feature-usage.json")),
  homeWorkspaceId: env.APP_WORKSPACE_ID,
  probe: isolatedMockProbe(),
});
const siteAuth = {
  kind: "enabled",
  auth: new SiteAuth(
    { username: process.env.SITE_AUTH_USERNAME || "admin", passwordHash, publicOrigin: origin },
    { allowHttpLoopback: true, publicRegistrationEnabled: false },
  ),
};
class IsolatedModule {}
Module({
  imports: [AuthModule.register(env, siteAuth)],
  controllers: [AdminModelsController, FeatureConfigController],
  providers: [
    { provide: ADMIN_MODELS_SERVICE, useValue: backend },
    { provide: FEATURE_CONFIG_SERVICE, useValue: featureConfig },
  ],
})(IsolatedModule);
const app = await NestFactory.create(IsolatedModule, { logger: false });
app.use("/api/v1/admin", (_req, response, next) => {
  setAdminResponseHeaders(response);
  next();
});
app.useBodyParser("json", { limit: "300kb" });
app.setGlobalPrefix("api/v1");
await app.listen(port, "127.0.0.1");
console.log(
  `Isolated admin API ready on loopback:${port}. Mock probe only. No DB or provider connections.`,
);
process.once("SIGTERM", () => {
  void app.close().then(() => process.exit(0));
});
process.once("SIGINT", () => {
  void app.close().then(() => process.exit(0));
});
