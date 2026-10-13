/**
 * Guard of the title writing acceptance run (src/title-writing-store.acceptance.spec.ts). That run writes: it applies
 * the migration chain (including the title writing migration) to a database. It must only ever touch a newly created,
 * empty, disposable database that a person named on purpose. Everything here refuses by default.
 *
 * Required, all of them:
 * - TITLE_WRITING_ACCEPTANCE_AUTHORIZED=true                  explicit authorization to migrate and write that database
 * - TITLE_WRITING_ACCEPTANCE_DATABASE_NAME=ads_title_acceptance_<suffix>   the disposable database's name
 * - TITLE_WRITING_ACCEPTANCE_DATABASE_URL=postgresql://.../<that name>     its own variable, never DATABASE_URL
 * Then, before any write, the connected database must report that name and contain no tables at all.
 */
export const TITLE_WRITING_ACCEPTANCE_NAME_PATTERN = /^ads_title_acceptance_[a-z0-9_]{6,40}$/;

export interface TitleWritingAcceptanceEnv {
  TITLE_WRITING_ACCEPTANCE_AUTHORIZED?: string | undefined;
  TITLE_WRITING_ACCEPTANCE_DATABASE_NAME?: string | undefined;
  TITLE_WRITING_ACCEPTANCE_DATABASE_URL?: string | undefined;
  DATABASE_URL?: string | undefined;
}

export type TitleWritingAcceptanceDecision =
  | { ok: true; url: string; databaseName: string }
  | { ok: false; reason: string };

function databaseNameOf(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "postgresql:" && parsed.protocol !== "postgres:") return null;
    const name = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
    return name.length > 0 && !name.includes("/") ? name : null;
  } catch {
    return null;
  }
}

/** Pure check of the environment. Runs before any connection is opened. */
export function checkTitleWritingAcceptanceEnv(env: TitleWritingAcceptanceEnv): TitleWritingAcceptanceDecision {
  if (env.TITLE_WRITING_ACCEPTANCE_AUTHORIZED !== "true") {
    return { ok: false, reason: "TITLE_WRITING_ACCEPTANCE_AUTHORIZED is not \"true\": writing to an acceptance database is not authorized." };
  }
  const expected = env.TITLE_WRITING_ACCEPTANCE_DATABASE_NAME;
  if (!expected || !TITLE_WRITING_ACCEPTANCE_NAME_PATTERN.test(expected)) {
    return { ok: false, reason: "TITLE_WRITING_ACCEPTANCE_DATABASE_NAME must name a disposable database: ads_title_acceptance_<6-40 of a-z 0-9 _>." };
  }
  const url = env.TITLE_WRITING_ACCEPTANCE_DATABASE_URL;
  if (!url) return { ok: false, reason: "TITLE_WRITING_ACCEPTANCE_DATABASE_URL is not set. DATABASE_URL is never used for this run." };
  const named = databaseNameOf(url);
  if (named === null) return { ok: false, reason: "TITLE_WRITING_ACCEPTANCE_DATABASE_URL is not a postgresql:// URL with a database name." };
  if (named !== expected) return { ok: false, reason: "The acceptance URL does not point at TITLE_WRITING_ACCEPTANCE_DATABASE_NAME." };
  if (env.DATABASE_URL) {
    if (env.DATABASE_URL === url) return { ok: false, reason: "The acceptance URL equals DATABASE_URL. Use a separate, new database." };
    if (databaseNameOf(env.DATABASE_URL) === expected) return { ok: false, reason: "DATABASE_URL names the same database. Use a separate, new database." };
  }
  return { ok: true, url, databaseName: expected };
}

export interface ReadOnlyQueryable {
  query(sql: string, values?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
}

/**
 * Read-only identity check on the opened connection, before any write: the server must report the expected database
 * and it must contain no tables in any schema (a newly created database). Any failure refuses.
 */
export async function verifyTitleWritingAcceptanceDatabase(client: ReadOnlyQueryable, expectedName: string): Promise<TitleWritingAcceptanceDecision> {
  try {
    const identity = await client.query("SELECT current_database() AS name");
    const actual = identity.rows[0]?.name;
    if (actual !== expectedName) return { ok: false, reason: "The connected database is not the named acceptance database." };
    const tables = await client.query(
      `SELECT count(*)::int AS tables FROM information_schema.tables
        WHERE table_schema NOT IN ('pg_catalog', 'information_schema') AND table_schema NOT LIKE 'pg_toast%'`,
    );
    const count = Number(tables.rows[0]?.tables ?? Number.NaN);
    if (!Number.isFinite(count)) return { ok: false, reason: "Could not confirm that the acceptance database is empty." };
    if (count !== 0) return { ok: false, reason: "The acceptance database is not empty. Create a new, empty database for each run." };
    return { ok: true, url: "", databaseName: expectedName };
  } catch {
    return { ok: false, reason: "Could not confirm the acceptance database's identity." };
  }
}
