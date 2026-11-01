// Pure unit tests. The queryable below is an in-memory fake; no connection, SQL execution or migration is performed.
import { describe, expect, it, vi } from "vitest";
import {
  checkSpeechAcceptanceEnv, SPEECH_ACCEPTANCE_NAME_PATTERN, verifySpeechAcceptanceDatabase,
  type SpeechAcceptanceEnv,
} from "./speech-acceptance-guard";

const NAME = "ads_speech_acceptance_offline_01";
const URL_VALUE = `postgresql://acceptance-host/${NAME}`;
const VALID: SpeechAcceptanceEnv = {
  SPEECH_ACCEPTANCE_AUTHORIZED: "true",
  SPEECH_ACCEPTANCE_DRAFT_AUTHORIZED: "true",
  SPEECH_ACCEPTANCE_DATABASE_NAME: NAME,
  SPEECH_ACCEPTANCE_DATABASE_URL: URL_VALUE,
};

describe("speech acceptance environment guard", () => {
  it("accepts only an explicitly authorized dedicated PostgreSQL database", () => {
    expect(checkSpeechAcceptanceEnv(VALID)).toEqual({ ok: true, url: URL_VALUE, databaseName: NAME });
    expect(checkSpeechAcceptanceEnv({ ...VALID, DATABASE_URL: "postgresql://business-host/production" }).ok).toBe(true);
    expect(checkSpeechAcceptanceEnv({ ...VALID, SPEECH_ACCEPTANCE_DATABASE_URL: `postgres://acceptance-host/${NAME}?sslmode=require` }).ok).toBe(true);
  });

  it.each([
    {},
    { ...VALID, SPEECH_ACCEPTANCE_AUTHORIZED: undefined },
    { ...VALID, SPEECH_ACCEPTANCE_AUTHORIZED: "TRUE" },
    { ...VALID, SPEECH_ACCEPTANCE_AUTHORIZED: " true" },
    { ...VALID, SPEECH_ACCEPTANCE_DRAFT_AUTHORIZED: undefined },
    { ...VALID, SPEECH_ACCEPTANCE_DRAFT_AUTHORIZED: "false" },
    { ...VALID, SPEECH_ACCEPTANCE_DATABASE_URL: undefined, DATABASE_URL: URL_VALUE },
  ])("refuses missing or inexact flags before a URL can be used: %j", (env) => {
    const result = checkSpeechAcceptanceEnv(env);
    expect(result.ok).toBe(false);
    expect("url" in result).toBe(false);
  });

  it.each([
    "production", "ads_speech_acceptance_short", "ads_speech_acceptance_Uppercase", "ads_speech_acceptance_has-dash",
    `ads_speech_acceptance_${"a".repeat(41)}`, `${NAME}\n`, `${NAME} `,
  ])("refuses a non-disposable or malformed database name: %j", (databaseName) => {
    expect(checkSpeechAcceptanceEnv({ ...VALID, SPEECH_ACCEPTANCE_DATABASE_NAME: databaseName,
      SPEECH_ACCEPTANCE_DATABASE_URL: `postgresql://host/${encodeURIComponent(databaseName)}` }).ok).toBe(false);
  });

  it("enforces both suffix length boundaries", () => {
    for (const length of [6, 40]) {
      const databaseName = `ads_speech_acceptance_${"a".repeat(length)}`;
      expect(SPEECH_ACCEPTANCE_NAME_PATTERN.test(databaseName)).toBe(true);
      expect(checkSpeechAcceptanceEnv({ ...VALID, SPEECH_ACCEPTANCE_DATABASE_NAME: databaseName,
        SPEECH_ACCEPTANCE_DATABASE_URL: `postgresql://host/${databaseName}` }).ok).toBe(true);
    }
  });

  it.each([
    `https://host/${NAME}`, `file:///${NAME}`, "not-a-url", "postgresql://host/production",
    `postgresql://host/${NAME}/other`, `postgresql://host/%2F${NAME}`, `postgresql://host/${NAME}%00`,
    `postgresql://host/%2561ds_speech_acceptance_offline_01`, `postgresql://host/%GG`,
    `postgresql://host/${NAME}#production`, ` postgresql://host/${NAME}`,
    `postgresql://host/${NAME}?database=production`, `postgresql://host/${NAME}?dbname=${NAME}`,
    `postgresql://host/${NAME}?DB=production`,
  ])("refuses an ambiguous, aliased or non-PostgreSQL acceptance URL: %j", (url) => {
    expect(checkSpeechAcceptanceEnv({ ...VALID, SPEECH_ACCEPTANCE_DATABASE_URL: url }).ok).toBe(false);
  });

  it.each([
    URL_VALUE,
    `postgres://different-host/${NAME}`,
    `postgresql://user:password@different-host:6543/${NAME}?sslmode=require`,
    `postgresql://different-host/%61ds_speech_acceptance_offline_01`,
    `postgresql://different-host/${NAME.replaceAll("_", "%5f")}`,
    `postgresql://different-host/production?dbname=${NAME}`,
    `postgresql://different-host/production?DATABASE=${NAME}`,
    ` postgresql://different-host/${NAME} `,
  ])("refuses the business database name even on a different host or encoded path: %j", (businessUrl) => {
    expect(checkSpeechAcceptanceEnv({ ...VALID, DATABASE_URL: businessUrl }).ok).toBe(false);
  });

  it("recognizes the same business database when the dedicated path itself is percent encoded", () => {
    const encoded = `postgresql://acceptance-host/${NAME.replaceAll("_", "%5F")}`;
    expect(checkSpeechAcceptanceEnv({ ...VALID, SPEECH_ACCEPTANCE_DATABASE_URL: encoded }).ok).toBe(true);
    expect(checkSpeechAcceptanceEnv({ ...VALID, SPEECH_ACCEPTANCE_DATABASE_URL: encoded, DATABASE_URL: `postgres://other/${NAME}` }).ok).toBe(false);
  });
});

describe("speech acceptance connected database guard (fake queryable only)", () => {
  it("uses read-only SELECTs to confirm exact identity and zero objects across every user schema", async () => {
    const calls: Array<{ sql: string; values?: unknown[] }> = [];
    const result = await verifySpeechAcceptanceDatabase({ query: async (sql, values) => {
      calls.push({ sql, values });
      return { rows: calls.length === 1 ? [{ name: NAME }] : [{ relations: "0" }] };
    } }, NAME);
    expect(result).toEqual({ ok: true, url: "", databaseName: NAME });
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.sql.trim()).toMatch(/^SELECT\b/i);
      expect(call.sql).not.toMatch(/\b(?:INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|TRUNCATE|GRANT|REVOKE|CALL|DO|COPY|SET)\b/i);
      expect(call.sql).not.toContain(";");
      expect(call.values).toBeUndefined();
    }
    expect(calls[0]?.sql).toBe("SELECT current_database() AS name");
    expect(calls[1]?.sql).toContain("pg_catalog.pg_class");
    for (const catalog of ["pg_proc", "pg_type", "pg_collation", "pg_operator", "pg_conversion", "pg_opclass", "pg_opfamily",
      "pg_ts_config", "pg_ts_dict", "pg_ts_parser", "pg_ts_template", "pg_constraint", "pg_extension", "pg_statistic_ext", "pg_default_acl"]) {
      expect(calls[1]?.sql).toContain(`pg_catalog.${catalog}`);
    }
    expect(calls[1]?.sql).toContain("UNION ALL");
    expect(calls[1]?.sql).toContain("pg_catalog.pg_namespace");
    expect(calls[1]?.sql).toContain("n.nspname NOT IN ('pg_catalog', 'information_schema')");
    expect(calls[1]?.sql).toContain("n.nspname !~ '^pg_toast'");
    expect(calls[1]?.sql).toContain("n.nspname !~ '^pg_temp_'");
    expect(calls[1]?.sql).not.toContain("relkind");
    expect(calls[1]?.sql).not.toContain("public");
    expect(calls[1]?.sql).not.toMatch(/NOT LIKE 'pg_/);
  });

  it("refuses objects in any non-system schema, including views, sequences and custom schema objects", async () => {
    let reads = 0;
    const result = await verifySpeechAcceptanceDatabase({ query: async () => {
      reads += 1;
      return { rows: reads === 1 ? [{ name: NAME }] : [{ relations: "3" }] };
    } }, NAME);
    expect(result.ok).toBe(false);
  });

  it.each(["pg_proc", "pg_type"])("refuses a non-system %s object even with no tables", async (catalog) => {
    let reads = 0;
    const result = await verifySpeechAcceptanceDatabase({ query: async (sql) => {
      reads += 1;
      if (reads === 1) return { rows: [{ name: NAME }] };
      expect(sql).toContain(`pg_catalog.${catalog}`);
      return { rows: [{ relations: "1" }] };
    } }, NAME);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("objects");
  });

  it("refuses a different actual database name before reading its relations", async () => {
    const query = vi.fn(async () => ({ rows: [{ name: "production" }] }));
    expect((await verifySpeechAcceptanceDatabase({ query }, NAME)).ok).toBe(false);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("refuses an invalid expected name before even using the provided queryable", async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    expect((await verifySpeechAcceptanceDatabase({ query }, "production")).ok).toBe(false);
    expect(query).not.toHaveBeenCalled();
  });

  it.each(["identity", "relations"])("refuses a %s query failure without leaking the connection error", async (stage) => {
    let reads = 0;
    const result = await verifySpeechAcceptanceDatabase({ query: async () => {
      reads += 1;
      if (stage === "identity" || reads === 2) throw new Error("credential-secret must not be reflected");
      return { rows: [{ name: NAME }] };
    } }, NAME);
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain("credential-secret");
  });

  it.each([undefined, null, false, "", "not-a-number", "-1", -1, 0.5, "0.0", "00"])("refuses an unverified relation count: %j", async (count) => {
    let reads = 0;
    const result = await verifySpeechAcceptanceDatabase({ query: async () => {
      reads += 1;
      return { rows: reads === 1 ? [{ name: NAME }] : [{ relations: count }] };
    } }, NAME);
    expect(result.ok).toBe(false);
  });

  it("accepts a numeric zero returned by a read-only query implementation", async () => {
    let reads = 0;
    expect((await verifySpeechAcceptanceDatabase({ query: async () => {
      reads += 1;
      return { rows: reads === 1 ? [{ name: NAME }] : [{ relations: 0 }] };
    } }, NAME)).ok).toBe(true);
  });
});
