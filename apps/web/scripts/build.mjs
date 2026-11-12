import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const nextBin = require.resolve("next/dist/bin/next");
const args = process.argv.slice(2);

if (args.some((arg) => arg === "--debug-prerender" || arg.startsWith("--debug-prerender="))) {
  console.error("Production builds cannot use --debug-prerender. Run `pnpm exec next build --debug-prerender` in an isolated Web directory for diagnosis; do not deploy its output.");
  process.exit(1);
}

// A deployment shell may inherit the API/worker's development mode. Next keeps
// an existing NODE_ENV, so pin only this build subprocess to production.
const result = spawnSync(process.execPath, [nextBin, "build", ...args], {
  stdio: "inherit",
  env: { ...process.env, NODE_ENV: "production" },
});

if (result.error) {
  console.error("Failed to start the Next.js production build:", result.error.message);
}
process.exit(result.status ?? 1);
