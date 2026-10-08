// Refusal logic of the title writing acceptance entry. Environment checks are pure; the identity check uses a scripted
// query client, so these tests prove the decision logic only, not anything about a real database.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  checkTitleWritingAcceptanceEnv,
  verifyTitleWritingAcceptanceDatabase,
  type ReadOnlyQueryable,
} from "./title-writing-acceptance-guard";

const NAME = "ads_title_acceptance_20261009a";
const URL_OK = `postgresql://u:p@127.0.0.1:5432/${NAME}`;
const AUTHORIZED = { TITLE_WRITING_DRAFT_SQL_AUTHORIZED: "true", TITLE_WRITING_ACCEPTANCE_DATABASE_NAME: NAME, TITLE_WRITING_ACCEPTANCE_DATABASE_URL: URL_OK };

describe("title writing acceptance environment", () => {
  it("accepts only an explicit authorization, a disposable name and a URL pointing at exactly that name", () => {
    expect(checkTitleWritingAcceptanceEnv(AUTHORIZED)).toEqual({ ok: true, url: URL_OK, databaseName: NAME });
  });

  it.each([
    ["nothing set", {}],
    ["only DATABASE_URL", { DATABASE_URL: URL_OK }],
    ["authorization not exactly true", { ...AUTHORIZED, TITLE_WRITING_DRAFT_SQL_AUTHORIZED: "1" }],
    ["no expected name", { ...AUTHORIZED, TITLE_WRITING_ACCEPTANCE_DATABASE_NAME: undefined }],
    ["a name that is not disposable", { ...AUTHORIZED, TITLE_WRITING_ACCEPTANCE_DATABASE_NAME: "ai_drama", TITLE_WRITING_ACCEPTANCE_DATABASE_URL: "postgresql://h/ai_drama" }],
    ["the production-like default name", { ...AUTHORIZED, TITLE_WRITING_ACCEPTANCE_DATABASE_NAME: "postgres", TITLE_WRITING_ACCEPTANCE_DATABASE_URL: "postgresql://h/postgres" }],
    ["no acceptance URL", { ...AUTHORIZED, TITLE_WRITING_ACCEPTANCE_DATABASE_URL: undefined }],
    ["a URL to another database", { ...AUTHORIZED, TITLE_WRITING_ACCEPTANCE_DATABASE_URL: "postgresql://u:p@127.0.0.1:5432/ai_drama" }],
    ["a URL without a database", { ...AUTHORIZED, TITLE_WRITING_ACCEPTANCE_DATABASE_URL: "postgresql://u:p@127.0.0.1:5432/" }],
    ["not a PostgreSQL URL", { ...AUTHORIZED, TITLE_WRITING_ACCEPTANCE_DATABASE_URL: `mysql://h/${NAME}` }],
    ["the same URL as DATABASE_URL", { ...AUTHORIZED, DATABASE_URL: URL_OK }],
    ["DATABASE_URL naming the same database elsewhere", { ...AUTHORIZED, DATABASE_URL: `postgresql://other:5432/${NAME}` }],
  ])("refuses: %s", (_label, env) => {
    const decision = checkTitleWritingAcceptanceEnv(env);
    expect(decision.ok).toBe(false);
    expect(JSON.stringify(decision)).not.toContain("u:p@");
  });
});

function scripted(answers: { name?: unknown; tables?: unknown; fail?: boolean }): ReadOnlyQueryable & { seen: string[] } {
  const seen: string[] = [];
  return {
    seen,
    async query(sql: string) {
      seen.push(sql);
      if (answers.fail) throw new Error("connection refused");
      if (sql.includes("current_database")) return { rows: [{ name: answers.name }] };
      return { rows: [{ tables: answers.tables }] };
    },
  };
}

describe("title writing acceptance database identity (scripted client)", () => {
  it("passes a new, empty database with the expected name, using read-only queries", async () => {
    const client = scripted({ name: NAME, tables: 0 });
    expect((await verifyTitleWritingAcceptanceDatabase(client, NAME)).ok).toBe(true);
    expect(client.seen.every((sql) => /^\s*SELECT\b/i.test(sql))).toBe(true);
  });

  it.each([
    ["another database name", { name: "ai_drama", tables: 0 }],
    ["a database that already has tables", { name: NAME, tables: 12 }],
    ["an unreadable table count", { name: NAME, tables: "x" }],
    ["a failing connection", { fail: true }],
  ])("refuses %s", async (_label, answers) => {
    expect((await verifyTitleWritingAcceptanceDatabase(scripted(answers), NAME)).ok).toBe(false);
  });
});

describe("title writing acceptance entry", () => {
  it("refuses before opening a connection and contains no destructive SQL", async () => {
    const source = await readFile(join(__dirname, "title-writing-store.acceptance.spec.ts"), "utf8");
    expect(source.indexOf("checkTitleWritingAcceptanceEnv(process.env)")).toBeGreaterThan(-1);
    expect(source.indexOf("checkTitleWritingAcceptanceEnv(process.env)")).toBeLessThan(source.indexOf("new Pool("));
    expect(source.indexOf("verifyTitleWritingAcceptanceDatabase(pool")).toBeLessThan(source.indexOf("runMigrations(pool)"));
    // SQL statements only (upper case, as the code writes them); the comments may say what is never done.
    expect(source).not.toMatch(/\bDROP\s+(SCHEMA|TABLE|DATABASE)\b|\bTRUNCATE\b|\bDELETE\s+FROM\b/);
    expect(source).not.toContain("process.env.DATABASE_URL");
  });

  it("the general integration file for title writing is read-only", async () => {
    const source = await readFile(join(__dirname, "title-writing-store.integration.spec.ts"), "utf8");
    expect(source).not.toMatch(/\bDROP\s|\bTRUNCATE\b|\bINSERT\s+INTO\b|\bUPDATE\s+\w+\s+SET\b|\bDELETE\s+FROM\b|\bCREATE\s|runMigrations|readFile/);
  });

  it("only the dedicated command collects the acceptance file, and it collects nothing else", async () => {
    const root = join(__dirname, "..");
    const unit = await readFile(join(root, "vitest.config.ts"), "utf8");
    const integration = await readFile(join(root, "vitest.integration.config.ts"), "utf8");
    const acceptance = await readFile(join(root, "vitest.title-writing-acceptance.config.ts"), "utf8");
    expect(unit).toContain("\"src/**/*.acceptance.spec.ts\"");
    expect(integration).toContain("include: [\"src/**/*.integration.spec.ts\"]");
    expect(acceptance).toContain("include: [\"src/title-writing-store.acceptance.spec.ts\"]");
    expect(acceptance.match(/include:/g)).toHaveLength(1);
    const scripts = (JSON.parse(await readFile(join(root, "package.json"), "utf8")) as { scripts: Record<string, string> }).scripts;
    expect(scripts["title-writing:acceptance"]).toBe("vitest run --config vitest.title-writing-acceptance.config.ts");
  });
});
