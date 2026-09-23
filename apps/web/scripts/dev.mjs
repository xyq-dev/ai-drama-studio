import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const port = process.env.WEB_PORT ?? "3000";
const host = process.env.BIND_HOST ?? "127.0.0.1";

if (!/^[0-9]+$/.test(port)) {
  console.error("WEB_PORT must be an integer");
  process.exit(1);
}

if (host !== "127.0.0.1" && host !== "localhost") {
  console.error("Web dev server only binds to 127.0.0.1 or localhost");
  process.exit(1);
}

const require = createRequire(import.meta.url);
const nextBin = require.resolve("next/dist/bin/next");
const child = spawn(process.execPath, [nextBin, "dev", "--hostname", host, "--port", port], {
  stdio: "inherit",
  env: process.env,
});

child.on("exit", (code) => {
  process.exit(code ?? 1);
});
