/** Pure admission and read-only verification shared by opt-in disposable PostgreSQL acceptance suites. */
export type DisposableAcceptanceDecision =
  | { ok: true; url: string; databaseName: string }
  | { ok: false; reason: string };

export interface DisposableAcceptanceEnv {
  databaseName?: string;
  url?: string;
  businessDatabaseUrl?: string;
  namePattern: RegExp;
  nameHint: string;
}
export interface DisposableReadOnlyQueryable {
  query(sql: string, values?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
}
const DATABASE_PARAMETERS = new Set(["database", "dbname", "db"]);
const matches = (pattern: RegExp, value: string): boolean => new RegExp(pattern.source, pattern.flags.replace(/[gy]/g, "")).test(value);
function postgresUrl(value: string): URL | null {
  try {
    if (value !== value.trim()) return null;
    const parsed = new URL(value);
    return parsed.protocol === "postgres:" || parsed.protocol === "postgresql:" ? parsed : null;
  } catch { return null; }
}
function pathDatabase(parsed: URL): string | null {
  try {
    if (!parsed.pathname.startsWith("/") || parsed.pathname.length < 2) return null;
    const value = decodeURIComponent(parsed.pathname.slice(1));
    // eslint-disable-next-line no-control-regex -- connection database names may not contain paths or controls
    return value && !/[/\\\u0000-\u0020\u007f]/.test(value) ? value : null;
  } catch { return null; }
}
function namesDatabase(value: string, expected: string): boolean {
  const parsed = postgresUrl(value.trim());
  if (!parsed) return false;
  if (pathDatabase(parsed) === expected) return true;
  for (const [key, parameter] of parsed.searchParams) {
    if (DATABASE_PARAMETERS.has(key.toLowerCase()) && parameter === expected) return true;
  }
  return false;
}

/** Wrappers must check their explicit authorization flags before calling this pure function or constructing a Pool. */
export function checkDisposableAcceptanceEnv(input: DisposableAcceptanceEnv): DisposableAcceptanceDecision {
  const databaseName = input.databaseName;
  if (!databaseName || databaseName.trim() !== databaseName || !matches(input.namePattern, databaseName)) {
    return { ok: false, reason: `Name a new disposable database matching ${input.nameHint}.` };
  }
  const url = input.url;
  if (!url) return { ok: false, reason: "A dedicated acceptance PostgreSQL URL is required; DATABASE_URL is never used." };
  const parsed = postgresUrl(url);
  if (!parsed || parsed.hash || pathDatabase(parsed) !== databaseName) {
    return { ok: false, reason: "The dedicated PostgreSQL URL must name exactly the disposable acceptance database." };
  }
  for (const [key] of parsed.searchParams) {
    if (DATABASE_PARAMETERS.has(key.toLowerCase())) {
      return { ok: false, reason: "Database query aliases are not allowed on the dedicated acceptance URL." };
    }
  }
  if (input.businessDatabaseUrl && (input.businessDatabaseUrl === url || namesDatabase(input.businessDatabaseUrl, databaseName))) {
    return { ok: false, reason: "The business DATABASE_URL names this database; use a separate disposable database." };
  }
  return { ok: true, url, databaseName };
}

/** Only SELECTs, before migrations: exact database identity and zero objects in every non-system schema. */
export async function verifyDisposableAcceptanceDatabase(client: DisposableReadOnlyQueryable, expectedName: string,
  namePattern: RegExp): Promise<DisposableAcceptanceDecision> {
  if (expectedName.trim() !== expectedName || !matches(namePattern, expectedName)) {
    return { ok: false, reason: "The expected disposable acceptance database name is invalid." };
  }
  try {
    const identity = await client.query("SELECT current_database() AS name");
    if (identity.rows[0]?.name !== expectedName) {
      return { ok: false, reason: "The connected database is not the exact named acceptance database." };
    }
    const objects = await client.query(
      `SELECT count(*)::text AS relations
         FROM (
           SELECT relnamespace AS namespace_oid FROM pg_catalog.pg_class
           UNION ALL SELECT pronamespace FROM pg_catalog.pg_proc
           UNION ALL SELECT typnamespace FROM pg_catalog.pg_type
           UNION ALL SELECT collnamespace FROM pg_catalog.pg_collation
           UNION ALL SELECT oprnamespace FROM pg_catalog.pg_operator
           UNION ALL SELECT connamespace FROM pg_catalog.pg_conversion
           UNION ALL SELECT opcnamespace FROM pg_catalog.pg_opclass
           UNION ALL SELECT opfnamespace FROM pg_catalog.pg_opfamily
           UNION ALL SELECT cfgnamespace FROM pg_catalog.pg_ts_config
           UNION ALL SELECT dictnamespace FROM pg_catalog.pg_ts_dict
           UNION ALL SELECT prsnamespace FROM pg_catalog.pg_ts_parser
           UNION ALL SELECT tmplnamespace FROM pg_catalog.pg_ts_template
           UNION ALL SELECT connamespace FROM pg_catalog.pg_constraint
           UNION ALL SELECT extnamespace FROM pg_catalog.pg_extension
           UNION ALL SELECT stxnamespace FROM pg_catalog.pg_statistic_ext
           UNION ALL SELECT defaclnamespace FROM pg_catalog.pg_default_acl
         ) AS object_namespace
         JOIN pg_catalog.pg_namespace AS n ON n.oid = object_namespace.namespace_oid
        WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
          AND n.nspname !~ '^pg_toast'
          AND n.nspname !~ '^pg_temp_'`,
    );
    // Keep the existing relation alias, but count all namespace-owned objects (including function/type-only schemas).
    const raw = objects.rows[0]?.relations;
    const count = typeof raw === "number" && Number.isSafeInteger(raw) && raw >= 0 ? String(raw)
      : typeof raw === "string" && /^(0|[1-9]\d*)$/.test(raw) ? raw : null;
    if (count === null) return { ok: false, reason: "Could not confirm that all non-system schemas are empty." };
    if (count !== "0") return { ok: false, reason: "The acceptance database has objects in a non-system schema; create a new empty database." };
    return { ok: true, url: "", databaseName: expectedName };
  } catch {
    return { ok: false, reason: "Could not verify the acceptance database identity and emptiness." };
  }
}
