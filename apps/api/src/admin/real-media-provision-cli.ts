import { createPostgresPool, closePostgresPool } from "@ai-drama/database";
import { ServerRealMediaRuntime, loadRealMediaEnvironment } from "@ai-drama/providers";
import { provisionRealMediaProviders } from "./real-media-provision";
async function main() {
  const args = process.argv.slice(2);
  if (args.some(a => !["--execute", "--enable-existing"].includes(a))) throw new Error("REAL_MEDIA_PROVISION_ARGUMENT_INVALID");
  const workspaceId = process.env.APP_WORKSPACE_ID;
  if (!workspaceId) throw new Error("APP_WORKSPACE_ID_REQUIRED");
  const environment = loadRealMediaEnvironment(process.env);
  const allowed = process.env.NODE_ENV !== "production" || environment.REAL_MEDIA_ALLOW_PRODUCTION === "true";
  const runtime = new ServerRealMediaRuntime(workspaceId, environment, allowed);
  const configurations = (await Promise.all((["image.generate", "video.generate", "audio.tts", "audio.music"] as const)
    .map(c => runtime.configurationFor(c)))).filter(c => c !== null);
  if (!configurations.length) throw new Error("REAL_MEDIA_NO_CONFIGURED_CAPABILITY");
  if (!args.includes("--execute")) {
    process.stdout.write(JSON.stringify({ mode: "plan", workspaceId,
      capabilities: configurations.map(c => ({ id: c.id, provider: c.providerKey, capability: c.capability, model: c.model, region: c.region,
        configurationVersion: c.version, currency: c.currency, priceVersion: c.priceVersion })),
      databaseWrites: 0, providerCalls: 0 }) + "\n");
    return;
  }
  if (!process.env.DATABASE_URL || !/^postgres(?:ql)?:\/\//.test(process.env.DATABASE_URL)) throw new Error("DATABASE_URL_REQUIRED");
  const pool = createPostgresPool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMs: 5000, statementTimeoutMs: 10000, queryTimeoutMs: 10000 });
  try {
    const result = await provisionRealMediaProviders(pool, { workspaceId, configurations, enableExisting: args.includes("--enable-existing") });
    process.stdout.write(JSON.stringify({ mode: "executed", ...result, providerCalls: 0 }) + "\n");
  } finally { await closePostgresPool(pool); }
}
void main().catch(() => { console.error("Real-media provisioning failed; no credential or connection details are logged."); process.exitCode = 1; });
