// Pure admission and fake-query tests. No PostgreSQL connection, statement execution or migration occurs here.
import { describe, expect, it, vi } from "vitest";
import { checkDisposableAcceptanceEnv, verifyDisposableAcceptanceDatabase, type DisposableAcceptanceEnv } from "./disposable-acceptance-guard";

const NAME = "ads_ci_acceptance_offline_01";
const PATTERN = /^ads_ci_acceptance_[a-z0-9_]{6,40}$/;
const URL_VALUE = `postgresql://acceptance-host/${NAME}`;
const VALID: DisposableAcceptanceEnv = { databaseName: NAME, url: URL_VALUE, namePattern: PATTERN, nameHint: "ads_ci_acceptance_<suffix>" };

describe("shared disposable acceptance environment guard", () => {
  it("uses only a dedicated, exact PostgreSQL database URL", () => {
    expect(checkDisposableAcceptanceEnv(VALID)).toEqual({ ok: true, url: URL_VALUE, databaseName: NAME });
    expect(checkDisposableAcceptanceEnv({ ...VALID, businessDatabaseUrl: "postgres://business-host/production" }).ok).toBe(true);
    expect(checkDisposableAcceptanceEnv({ ...VALID, url: `postgres://host/${NAME}?sslmode=require` }).ok).toBe(true);
    expect(checkDisposableAcceptanceEnv({ ...VALID, url: `postgresql://host/${NAME.replaceAll("_", "%5F")}` }).ok).toBe(true);
  });
  it("matches a reusable pattern without inheriting RegExp lastIndex state", () => {
    const input = { ...VALID, namePattern: new RegExp(PATTERN.source, "g") };
    expect(checkDisposableAcceptanceEnv(input).ok).toBe(true);
    expect(checkDisposableAcceptanceEnv(input).ok).toBe(true);
  });
  it.each([undefined, "production", "ads_ci_acceptance_short", `${NAME} `, `ads_ci_acceptance_${"x".repeat(41)}`])("refuses a missing or non-disposable database name: %j", (databaseName) => {
    expect(checkDisposableAcceptanceEnv({ ...VALID, databaseName }).ok).toBe(false);
  });
  it.each([
    undefined, "not-a-url", `https://host/${NAME}`, `postgresql://host/production`, `postgresql://host/${NAME}/other`,
    `postgresql://host/${NAME}%00`, `postgresql://host/%2F${NAME}`, `postgresql://host/%GG`,
    `postgresql://host/${NAME}#other`, ` postgresql://host/${NAME}`, `postgresql://host/${NAME}?database=production`,
    `postgresql://host/${NAME}?dbname=${NAME}`, `postgresql://host/${NAME}?DB=production`,
  ])("refuses absent, ambiguous or aliased connection URLs: %j", (url) => {
    const result = checkDisposableAcceptanceEnv({ ...VALID, url });
    expect(result.ok).toBe(false); expect("url" in result).toBe(false);
  });
  it.each([
    URL_VALUE, `postgres://different-host/${NAME}`, `postgres://user:password@host:6543/${NAME}?sslmode=require`,
    `postgresql://other/${NAME.replaceAll("_", "%5f")}`, `postgresql://other/production?DATABASE=${NAME}`,
    `postgresql://other/production?db=${NAME}`, ` postgresql://other/${NAME} `,
  ])("refuses a business database with the same name on any host or alias: %j", (businessDatabaseUrl) => {
    expect(checkDisposableAcceptanceEnv({ ...VALID, businessDatabaseUrl }).ok).toBe(false);
  });
});

describe("shared connected disposable acceptance guard (fake queryable only)", () => {
  it("checks exact identity then all schema-owned objects using only SELECTs", async () => {
    const calls: string[] = [];
    const result = await verifyDisposableAcceptanceDatabase({ query: async (sql) => {
      calls.push(sql); return { rows: calls.length === 1 ? [{ name: NAME }] : [{ relations: "0" }] };
    } }, NAME, PATTERN);
    expect(result).toEqual({ ok: true, url: "", databaseName: NAME }); expect(calls).toHaveLength(2);
    for (const sql of calls) {
      expect(sql.trim()).toMatch(/^SELECT\b/i);
      expect(sql).not.toMatch(/\b(?:INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|TRUNCATE|GRANT|REVOKE|CALL|DO|COPY|SET)\b/i);
      expect(sql).not.toContain(";");
    }
    for (const catalog of ["pg_class", "pg_proc", "pg_type", "pg_collation", "pg_operator", "pg_conversion", "pg_opclass", "pg_opfamily",
      "pg_ts_config", "pg_ts_dict", "pg_ts_parser", "pg_ts_template", "pg_constraint", "pg_extension", "pg_statistic_ext", "pg_default_acl"]) expect(calls[1]).toContain(`pg_catalog.${catalog}`);
    expect(calls[1]).toContain("pg_catalog.pg_namespace"); expect(calls[1]).not.toContain("public");
    expect(calls[1]).toContain("n.nspname !~ '^pg_toast'"); expect(calls[1]).toContain("n.nspname !~ '^pg_temp_'");
    expect(calls[1]).not.toMatch(/NOT LIKE 'pg_/);
  });
  it.each(["pg_proc", "pg_type", "pg_class"])("rejects a non-system %s object even without a business table", async (catalog) => {
    let reads = 0;
    const result = await verifyDisposableAcceptanceDatabase({ query: async (sql) => {
      reads += 1;
      if (reads === 1) return { rows: [{ name: NAME }] };
      expect(sql).toContain(`pg_catalog.${catalog}`); return { rows: [{ relations: "1" }] };
    } }, NAME, PATTERN);
    expect(result.ok).toBe(false);
  });
  it("refuses invalid expected names without using the queryable", async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    expect((await verifyDisposableAcceptanceDatabase({ query }, "production", PATTERN)).ok).toBe(false);
    expect(query).not.toHaveBeenCalled();
  });
  it("refuses a different actual database before reading objects", async () => {
    const query = vi.fn(async () => ({ rows: [{ name: "production" }] }));
    expect((await verifyDisposableAcceptanceDatabase({ query }, NAME, PATTERN)).ok).toBe(false);
    expect(query).toHaveBeenCalledOnce();
  });
  it.each([undefined, null, false, "", "not-a-count", "-1", -1, 0.5, "0.0", "00"])("refuses an unverified object count: %j", async (count) => {
    let reads = 0;
    expect((await verifyDisposableAcceptanceDatabase({ query: async () => {
      reads += 1; return { rows: reads === 1 ? [{ name: NAME }] : [{ relations: count }] };
    } }, NAME, PATTERN)).ok).toBe(false);
  });
  it.each(["identity", "objects"])("refuses %s query failures without reflecting connection details", async (stage) => {
    let reads = 0;
    const result = await verifyDisposableAcceptanceDatabase({ query: async () => {
      reads += 1; if (stage === "identity" || reads === 2) throw new Error("private credential error");
      return { rows: [{ name: NAME }] };
    } }, NAME, PATTERN);
    expect(result.ok).toBe(false); expect(JSON.stringify(result)).not.toContain("private credential");
  });
});
