// Start the isolated admin preview: mock-probe API + Next dev. No DB, no paid outbound.
// Secrets are read from ADMIN_AI_MODELS_SECRETS_DIR and never printed.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const root = resolve(fileURLToPath(new URL("../", import.meta.url)));
const reviewDir =
  process.env.ADMIN_AI_MODELS_REVIEW_DIR ||
  "/workspace/drama-studio/reviews/admin-ai-models-writing-2026-11-23";
const secretsDir = process.env.ADMIN_AI_MODELS_SECRETS_DIR || resolve(reviewDir, ".secrets");
const runtimeDir =
  process.env.ADMIN_AI_MODELS_RUNTIME_DIR || resolve(reviewDir, "isolated-runtime");
const webPort = process.env.WEB_PORT || "3822";
const apiPort = process.env.ADMIN_AI_MODELS_API_PORT || "3843";
const origin = `http://127.0.0.1:${webPort}`;
const apiOrigin = `http://127.0.0.1:${apiPort}`;

function readSecret(name) {
  return readFileSync(resolve(secretsDir, name), "utf8").trim();
}

const password = readSecret("ADMIN_MODELS_TEST_PASSWORD");
const masterKey = readSecret("MODEL_ADMIN_MASTER_KEY");
if (password.length < 16 || !/^[a-fA-F0-9]{64}$/.test(masterKey)) {
  console.error("Isolated preview secrets are missing or the wrong length.");
  process.exit(1);
}

mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });

const children = [];
function launch(args, cwd, env) {
  const child = spawn(process.execPath, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  const onData = (chunk) => {
    const text = chunk.toString();
    log += text;
    // Never echo logs that might contain secrets; only readiness lines go to stdout.
  };
  child.stdout.on("data", onData);
  child.stderr.on("data", onData);
  children.push({ child, log: () => log, label: args[0] });
  return child;
}

async function waitHttp(url, status, timeoutMs = 180_000) {
  const limit = Date.now() + timeoutMs;
  while (Date.now() < limit) {
    try {
      if ((await fetch(url)).status === status) return;
    } catch {
      /* readiness */
    }
    if (children.some(({ child }) => child.exitCode !== null)) {
      const dead = children.find(({ child }) => child.exitCode !== null);
      throw new Error(
        `Process exited before readiness (${dead?.label}). Last log tail:\n${dead?.log().slice(-2000)}`,
      );
    }
    await delay(250);
  }
  throw new Error(`Readiness timed out: ${url}`);
}

const apiEnv = {
  ADMIN_AI_MODELS_ISOLATED: "local-temporary-storage",
  ADMIN_AI_MODELS_RUNTIME_DIR: runtimeDir,
  ADMIN_AI_MODELS_API_PORT: apiPort,
  ADMIN_MODELS_TEST_PASSWORD: password,
  MODEL_ADMIN_MASTER_KEY: masterKey,
  SITE_AUTH_USERNAME: "admin",
  SITE_AUTH_PUBLIC_ORIGIN: origin,
};
const webEnv = {
  WEB_PORT: webPort,
  BIND_HOST: "127.0.0.1",
  NEXT_PUBLIC_API_BASE_URL: apiOrigin,
  NODE_ENV: "development",
};

launch(["scripts/admin-ai-models-isolated-server.mjs"], root, apiEnv);
const webRequire = createRequire(resolve(root, "apps/web/package.json"));
launch(
  [webRequire.resolve("next/dist/bin/next"), "dev", "--hostname", "127.0.0.1", "--port", webPort],
  resolve(root, "apps/web"),
  webEnv,
);

try {
  await waitHttp(`${apiOrigin}/api/v1/auth/session`, 200);
  await waitHttp(`${origin}/login`, 200);
} catch (error) {
  console.error(String(error));
  for (const item of children) item.child.kill("SIGTERM");
  process.exit(1);
}

writeFileSync(
  resolve(reviewDir, "PREVIEW.txt"),
  [
    `url=${origin}`,
    `admin=${origin}/admin/ai-models`,
    `writing=${origin}/admin/features?feature=writing`,
    `api=${apiOrigin}`,
    "username_env=SITE_AUTH_USERNAME",
    "password_env=ADMIN_MODELS_TEST_PASSWORD",
    `secrets_dir=${secretsDir}`,
    "auth=operator site login; default username is the SITE_AUTH_USERNAME value (admin).",
    "providers=mock probe only; no paid outbound.",
  ].join("\n") + "\n",
);
writeFileSync(
  resolve(runtimeDir, "pids.json"),
  JSON.stringify(
    {
      api: children[0].child.pid,
      web: children[1].child.pid,
      origin,
      apiOrigin,
    },
    null,
    2,
  ),
);

console.log(`Isolated admin preview ready at ${origin}`);
console.log(
  "Login: SITE_AUTH_USERNAME (see secrets dir for ADMIN_MODELS_TEST_PASSWORD). Mock probe only.",
);

const stop = () => {
  for (const item of children) {
    try {
      item.child.kill("SIGTERM");
    } catch {
      /* already gone */
    }
  }
  setTimeout(() => process.exit(0), 1500).unref();
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
await new Promise(() => {});
