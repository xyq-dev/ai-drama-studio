// Isolated browser fixture: real admin HTTP/auth/encrypted storage; no application DB, model or paid transport.
import { createRequire } from "node:module";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

if (process.env.ADMIN_MODELS_BROWSER_ACCEPTANCE !== "local-temporary-storage") {
  console.error("Explicit local-temporary-storage acceptance flag required.");
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
const { AdminModelsController, ADMIN_MODELS_SERVICE } = require(join(root, "apps/api/dist/admin/admin-models.controller.js"));
const { ADMIN_AUTH, setAdminResponseHeaders } = require(join(root, "apps/api/dist/admin/admin-auth.js"));
const directory = await mkdtemp(join(tmpdir(), "admin-browser-"));
await chmod(directory, 0o700);
// Defense in depth: this fixture has no provider transport, and any accidental fetch fails.
globalThis.fetch = async () => { throw new Error("Browser fixture forbids all outbound fetches."); };
const env = loadApiEnv({
  NODE_ENV: "test", DATABASE_URL: "postgresql://unused:unused@127.0.0.1:1/no_database",
  REDIS_URL: "redis://127.0.0.1:1", S3_ENDPOINT: "http://127.0.0.1:1", S3_REGION: "test", S3_BUCKET: "unused",
  S3_ACCESS_KEY_ID: "unused", S3_SECRET_ACCESS_KEY: "unused", APP_WORKSPACE_ID: "11111111-1111-4111-8111-111111111111",
  MODEL_ADMIN_ENABLED: "true", MODEL_ADMIN_PUBLIC_ORIGIN: "http://127.0.0.1:3820",
  MODEL_ADMIN_MASTER_KEY: randomBytes(32).toString("hex"), MODEL_ADMIN_CONFIG_PATH: join(directory, "models.enc"),
  MODEL_ADMIN_TOKEN: "test-only-admin-credential-" + "x".repeat(24),
});
const bootstrap = adminBootstrap(env);
const backend = await AdminModelsService.open(env, bootstrap, async () => true);
class AcceptanceModule {}
Module({ controllers: [AdminModelsController], providers: [
  { provide: ADMIN_AUTH, useValue: bootstrap.auth }, { provide: ADMIN_MODELS_SERVICE, useValue: backend },
] })(AcceptanceModule);
const app = await NestFactory.create(AcceptanceModule, { logger: false });
app.use("/api/v1/admin", (_req, response, next) => { setAdminResponseHeaders(response); next(); });
app.useBodyParser("json", { limit: "300kb" });
app.setGlobalPrefix("api/v1");
await app.listen(3841, "127.0.0.1");
console.log("Real admin HTTP browser fixture ready on loopback:3841. No DB or provider connections.");
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  try { await app.close(); } finally { await rm(directory, { recursive: true, force: true }); }
}
process.once("SIGTERM", () => { void close().then(() => process.exit(0)); });
process.once("SIGINT", () => { void close().then(() => process.exit(0)); });
