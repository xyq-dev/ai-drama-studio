import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const repo = resolve(import.meta.dirname, "..");
const python = process.env.MEDIA_WORKER_PYTHON ?? (process.platform === "win32" ? "python" : "python3");
const result = spawnSync(python, ["-m", "pytest", "services/media-worker/tests/test_compose_cli.py", "-q"], {
  cwd: repo,
  env: { ...process.env, PYTHONPATH: resolve(repo, "services/media-worker/src") },
  stdio: "inherit",
});
if (result.error) {
  process.stderr.write(`media-worker tests could not start: ${result.error.message}\n`);
  process.exit(1);
}
process.exit(result.status ?? 1);
