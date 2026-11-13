import { loadRealMediaEnvironment, ServerRealMediaRuntime } from "@ai-drama/providers";

async function main() {
  if (!process.env.APP_WORKSPACE_ID) throw new Error("APP_WORKSPACE_ID_REQUIRED");
  const environment = loadRealMediaEnvironment(process.env);
  const runtime = new ServerRealMediaRuntime(process.env.APP_WORKSPACE_ID, environment, false);
  const result = await runtime.probeComfyUi();
  process.stdout.write(JSON.stringify(result) + "\n");
  if (result.status !== "ready") process.exitCode = 1;
}

void main().catch(() => {
  console.error("ComfyUI configuration or read-only connection check failed.");
  process.exitCode = 1;
});
