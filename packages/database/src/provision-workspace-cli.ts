import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { closePostgresPool, createPostgresPool } from "./index";

function findRepoRoot(start: string): string {
  let current = resolve(start);
  for (;;) {
    if (existsSync(join(current, "pnpm-workspace.yaml"))) return current;
    const parent = dirname(current);
    if (parent === current) return resolve(start);
    current = parent;
  }
}

function readEnvFile(filePath: string): Record<string, string> {
  if (!existsSync(filePath)) return {};
  const values: Record<string, string> = {};
  for (const line of readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const normalized = trimmed.startsWith("export ") ? trimmed.slice("export ".length).trim() : trimmed;
    const separator = normalized.indexOf("=");
    if (separator <= 0) continue;
    const key = normalized.slice(0, separator).trim();
    let value = normalized.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) values[key] = value;
  }
  return values;
}

const root = findRepoRoot(__dirname);
const fileEnv = readEnvFile(join(root, ".env"));
const databaseUrl = process.env.DATABASE_URL ?? fileEnv.DATABASE_URL;
const workspaceId = process.env.APP_WORKSPACE_ID ?? fileEnv.APP_WORKSPACE_ID;
const workspaceName = process.env.APP_WORKSPACE_NAME ?? fileEnv.APP_WORKSPACE_NAME ?? "AI Drama Studio";

if (!databaseUrl) throw new Error("DATABASE_URL is required");
if (!workspaceId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(workspaceId)) {
  throw new Error("APP_WORKSPACE_ID must be a UUID");
}
const parsed = new URL(databaseUrl);
if (parsed.protocol !== "postgresql:" && parsed.protocol !== "postgres:") {
  throw new Error("DATABASE_URL must use PostgreSQL");
}

const pool = createPostgresPool({
  connectionString: databaseUrl,
  connectionTimeoutMs: 5_000,
  statementTimeoutMs: 10_000,
  queryTimeoutMs: 10_000,
});

async function main(): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO workspace (id, name, status)
       VALUES ($1, $2, 'ACTIVE')
       ON CONFLICT (id) DO NOTHING`,
      [workspaceId, workspaceName],
    );
    const result = await pool.query(
      "SELECT id, status FROM workspace WHERE id = $1",
      [workspaceId],
    ) as { rows: Array<{ id: string; status: string }> };
    const workspace = result.rows[0];
    if (!workspace) throw new Error("Configured workspace could not be provisioned");
    if (workspace.status !== "ACTIVE") throw new Error("Configured workspace exists but is not ACTIVE");
    process.stdout.write(`Workspace ${workspace.id} is provisioned and ACTIVE.\n`);
  } finally {
    await closePostgresPool(pool);
  }
}

void main();
