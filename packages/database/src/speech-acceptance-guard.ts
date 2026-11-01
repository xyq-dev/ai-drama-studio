/** Dedicated disposable database only; checking these flags never opens a connection or runs a migration. */
export const SPEECH_ACCEPTANCE_NAME_PATTERN = /^ads_speech_acceptance_[a-z0-9_]{6,40}$/;

export interface SpeechAcceptanceEnv {
  SPEECH_ACCEPTANCE_AUTHORIZED?: string;
  SPEECH_ACCEPTANCE_DRAFT_AUTHORIZED?: string;
  SPEECH_ACCEPTANCE_DATABASE_NAME?: string;
  SPEECH_ACCEPTANCE_DATABASE_URL?: string;
  DATABASE_URL?: string;
}

export type SpeechAcceptanceDecision =
  | { ok: true; url: string; databaseName: string }
  | { ok: false; reason: string };

const DATABASE_PARAMETERS = new Set(["database", "dbname", "db"]);

function postgresUrl(value: string): URL | null {
  try {
    if (value !== value.trim()) return null;
    const parsed = new URL(value);
    if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") return null;
    return parsed;
  } catch { return null; }
}

function pathDatabase(parsed: URL): string | null {
  try {
    const path = parsed.pathname;
    if (!path.startsWith("/") || path.length < 2) return null;
    const decoded = decodeURIComponent(path.slice(1));
    // A path must be one exact database name, never another path or a libpq connection expression.
    // eslint-disable-next-line no-control-regex -- reject path separators, controls and whitespace in database names
    if (!decoded || /[/\\\u0000-\u0020\u007f]/.test(decoded)) return null;
    return decoded;
  } catch { return null; }
}

function namesDatabase(value: string, expected: string): boolean {
  const parsed = postgresUrl(value.trim());
  if (!parsed) return false;
  if (pathDatabase(parsed) === expected) return true;
  // Conservatively reject a business URL whose query also names this database, regardless of parser precedence.
  for (const [key, parameter] of parsed.searchParams) {
    if (DATABASE_PARAMETERS.has(key.toLowerCase()) && parameter === expected) return true;
  }
  return false;
}

/** Pure, refusal-by-default check. Call this before constructing a Pool; DATABASE_URL is never a fallback. */
export function checkSpeechAcceptanceEnv(env: SpeechAcceptanceEnv): SpeechAcceptanceDecision {
  if (env.SPEECH_ACCEPTANCE_AUTHORIZED !== "true" || env.SPEECH_ACCEPTANCE_DRAFT_AUTHORIZED !== "true") {
    return { ok: false, reason: "Both SPEECH_ACCEPTANCE_AUTHORIZED and SPEECH_ACCEPTANCE_DRAFT_AUTHORIZED must be exactly true." };
  }
  const databaseName = env.SPEECH_ACCEPTANCE_DATABASE_NAME;
  if (!databaseName || databaseName.trim() !== databaseName || !SPEECH_ACCEPTANCE_NAME_PATTERN.test(databaseName)) {
    return { ok: false, reason: "Name a new disposable ads_speech_acceptance_<6-40 of a-z 0-9 _> database." };
  }
  const url = env.SPEECH_ACCEPTANCE_DATABASE_URL;
  if (!url) return { ok: false, reason: "SPEECH_ACCEPTANCE_DATABASE_URL is required; DATABASE_URL is never used." };
  const parsed = postgresUrl(url);
  if (!parsed || parsed.hash || pathDatabase(parsed) !== databaseName) {
    return { ok: false, reason: "The dedicated PostgreSQL URL must name exactly SPEECH_ACCEPTANCE_DATABASE_NAME." };
  }
  for (const [key] of parsed.searchParams) {
    if (DATABASE_PARAMETERS.has(key.toLowerCase())) {
      return { ok: false, reason: "Database query aliases are not allowed on the dedicated acceptance URL." };
    }
  }
  if (env.DATABASE_URL && (env.DATABASE_URL === url || namesDatabase(env.DATABASE_URL, databaseName))) {
    return { ok: false, reason: "The business DATABASE_URL names this database; use a separate disposable database." };
  }
  return { ok: true, url, databaseName };
}

export interface SpeechReadOnlyQueryable {
  query(sql: string, values?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
}

/**
 * Read-only verification before any write. All user schemas must have zero objects, including functions and types
 * without tables, relations, operators, text search objects and extensions. The `relations` result alias is retained
 * for callers; its count covers namespace-owned objects rather than only pg_class relations.
 */
export async function verifySpeechAcceptanceDatabase(client: SpeechReadOnlyQueryable, expectedName: string): Promise<SpeechAcceptanceDecision> {
  if (expectedName.trim() !== expectedName || !SPEECH_ACCEPTANCE_NAME_PATTERN.test(expectedName)) {
    return { ok: false, reason: "The expected speech acceptance database name is invalid." };
  }
  try {
    const identity = await client.query("SELECT current_database() AS name");
    if (identity.rows[0]?.name !== expectedName) {
      return { ok: false, reason: "The connected database is not the exact named speech acceptance database." };
    }
    const relations = await client.query(
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
    const raw = relations.rows[0]?.relations;
    const count = typeof raw === "number" && Number.isSafeInteger(raw) && raw >= 0 ? String(raw)
      : typeof raw === "string" && /^(0|[1-9]\d*)$/.test(raw) ? raw : null;
    if (count === null) return { ok: false, reason: "Could not confirm that all non-system schemas are empty." };
    if (count !== "0") return { ok: false, reason: "The acceptance database has objects in a non-system schema; create a new empty database." };
    return { ok: true, url: "", databaseName: expectedName };
  } catch {
    return { ok: false, reason: "Could not verify the speech acceptance database identity and emptiness." };
  }
}
