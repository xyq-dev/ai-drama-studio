import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EPISODE_PLAN_COLUMNS, EPISODE_PLAN_MIGRATION } from "./episode-plan";
import { SCRIPT_BREAKDOWN_COLUMNS, SCRIPT_BREAKDOWN_MIGRATION, TITLE_WRITING_MIGRATION, TITLE_WRITING_TABLES, WRITING_PROVIDER_MIGRATION } from "./title-writing-store";

const drafts = join(__dirname, "..", "prisma", "drafts");
const applied = join(__dirname, "..", "prisma", "migrations");

describe("unapplied migration drafts", () => {
  it("keeps the qwen and character-reference drafts out of the applied migration directory", async () => {
    const appliedNames = await readdir(applied);
    expect(appliedNames.some((name) => name.includes("qwen") || name.includes("character_reference"))).toBe(false);
    const qwen = await readFile(join(drafts, "20261005000100_qwen_web_writing.sql"), "utf8");
    expect(qwen).toContain("DRAFT");
    expect(qwen).toContain("UNIQUE (workspace_id, actor_id, idempotency_key)");
    expect(qwen).toContain("CHECK (billing_amount IS NULL)");
    expect(qwen).toContain("candidate_json");
    expect(qwen).toContain("'reserved', 'submitted', 'completed', 'rejected', 'unknown'");
    const reference = await readFile(join(drafts, "20261005000200_character_reference_image.sql"), "utf8");
    expect(reference).toContain("reference_role = 'character_reference'");
    expect(reference).toContain("character_reference_selection");
    expect(reference).toContain("Do not apply");
  });

});

/** SQL without comment lines and blank lines: the statements alone. */
function statements(sql: string): string {
  return sql.split("\n").filter((line) => line.trim().length > 0 && !line.trimStart().startsWith("--")).join("\n");
}

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

describe("title writing formal migration", () => {
  const migrationPath = join(applied, TITLE_WRITING_MIGRATION, "migration.sql");
  const draftPath = join(drafts, `${TITLE_WRITING_MIGRATION}.sql`);

  it("is the accepted draft's statements unchanged; only the header comments differ", async () => {
    const migration = await readFile(migrationPath, "utf8");
    const draft = await readFile(draftPath, "utf8");
    expect(statements(migration)).toBe(statements(draft));
    // Byte for byte from the first statement on, inline comments included.
    const body = (sql: string) => sql.slice(sql.indexOf("CREATE TABLE title_writing_run"));
    expect(body(migration)).toBe(body(draft));
  });

  it("is additive: creates only title_writing_ tables and indexes and writes no rows", async () => {
    const sql = statements(await readFile(migrationPath, "utf8"));
    // Every statement creates something; nothing alters, drops, writes or grants. (ON DELETE CASCADE is part of a FK.)
    const each = sql.split(";").map((item) => item.trim()).filter(Boolean);
    expect(each.length).toBeGreaterThan(0);
    expect(each.every((item) => /^CREATE (TABLE|INDEX|UNIQUE INDEX) title_writing_\w+ /.test(item))).toBe(true);
    const created = [...sql.matchAll(/^CREATE (?:UNIQUE )?(TABLE|INDEX) (\w+)(?: ON (\w+))?/gim)].map((match) => [match[1], match[2], match[3]]);
    expect(created.filter(([kind]) => kind === "TABLE").map(([, name]) => name))
      .toEqual(["title_writing_run", "title_writing_step", "title_writing_call", "title_writing_resume"]);
    expect(created.every(([, name, on]) => name!.startsWith("title_writing_") && (on === undefined || on.startsWith("title_writing_")))).toBe(true);
    expect(sql).toContain("UNIQUE (workspace_id, actor_id, idempotency_key)");
    expect(sql).toContain("WHERE state = 'running'");
    expect(sql).toContain("CHECK (billing_status = 'unknown')");
    expect(sql).not.toMatch(/amount\w*\s+(numeric|decimal)/i);
    expect(sql).not.toContain("qwen_writing_request");
  });

  it("is applied after every earlier migration, and the draft is marked superseded and not applied", async () => {
    const names = (await readdir(applied)).filter((name) => /^\d+_/.test(name)).sort();
    expect(names.indexOf(TITLE_WRITING_MIGRATION)).toBe(Object.keys(RELEASED).indexOf(TITLE_WRITING_MIGRATION));
    expect(names).toEqual([...Object.keys(RELEASED), SCRIPT_BREAKDOWN_MIGRATION, WRITING_PROVIDER_MIGRATION]);
    const draft = await readFile(draftPath, "utf8");
    expect(draft.split("\n")[0]).toBe("-- SUPERSEDED DRAFT. Do not apply. Kept only as the record of what passed the isolated acceptances.");
    expect(draft).toContain(`prisma/migrations/${TITLE_WRITING_MIGRATION}/migration.sql`);
  });

  it("leaves every released migration byte for byte as released (their applied checksums)", async () => {
    for (const [name, checksum] of Object.entries(RELEASED)) {
      expect(sha256(await readFile(join(applied, name, "migration.sql"), "utf8")), name).toBe(checksum);
    }
  });

  it("is expressed in the Prisma schema with the columns the store reads", async () => {
    const schema = await readFile(join(__dirname, "..", "prisma", "schema.prisma"), "utf8");
    for (const [table, titleColumns] of Object.entries(TITLE_WRITING_TABLES)) {
      // The script breakdown migration adds columns to title_writing_run; title writing itself never needs them.
      const columns = [...titleColumns, ...(table === "title_writing_run" ? SCRIPT_BREAKDOWN_COLUMNS.title_writing_run : [])];
      const model = [...schema.matchAll(/^model \w+ \{\n([\s\S]*?)\n\}/gm)].map((match) => match[1]!)
        .find((block) => block.includes(`@@map("${table}")`));
      expect(model, table).toBeDefined();
      const mapped = [...model!.matchAll(/^[ \t]+(\w+)[ \t]+\w+\??(?:[ \t][^\n]*)?$/gm)]
        .map((match) => /@map\("(\w+)"\)/.exec(match[0])?.[1] ?? match[1]!.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`))
        .filter((column) => !column.startsWith("@@"));
      expect([...mapped].sort(), table).toEqual([...columns].sort());
    }
  });
});

describe("episode plan migration", () => {
  const migrationPath = join(applied, EPISODE_PLAN_MIGRATION, "migration.sql");

  it("is released right after the title writing migration", async () => {
    const names = (await readdir(applied)).filter((name) => /^\d+_/.test(name)).sort();
    expect(names.indexOf(EPISODE_PLAN_MIGRATION)).toBe(names.indexOf(TITLE_WRITING_MIGRATION) + 1);
    expect(Object.keys(RELEASED)).toContain(EPISODE_PLAN_MIGRATION);
  });

  it("only expands: adds two project columns and widens CHECKs, writing, rewriting or dropping no data", async () => {
    const sql = statements(await readFile(migrationPath, "utf8"));
    const each = sql.split(";").map((item) => item.replace(/\s+/g, " ").trim()).filter(Boolean);
    expect(each.every((item) => /^ALTER TABLE (project|episode|title_writing_step) (ADD COLUMN|ADD CONSTRAINT|DROP CONSTRAINT) /.test(item))).toBe(true);
    expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE|DROP TABLE|DROP COLUMN|ALTER COLUMN|RENAME)\b/i);
    // Both new columns: the count defaults to the old fixed three, the target stays NULL for every existing project.
    expect(sql).toContain("ADD COLUMN episode_count smallint NOT NULL DEFAULT 3;");
    expect(sql).toContain("ADD COLUMN target_episode_seconds smallint;");
    expect(sql).toContain("CHECK (target_episode_seconds IS NOT NULL OR episode_count = 3)");
    // Every dropped constraint is re-added under the same name with a range that contains the old one.
    const dropped = [...sql.matchAll(/DROP CONSTRAINT (\w+)/g)].map((match) => match[1]);
    const added = [...sql.matchAll(/ADD CONSTRAINT (\w+)/g)].map((match) => match[1]);
    expect(dropped).toEqual(["episode_episode_no_check", "title_writing_step_step_key_check", "title_writing_step_ordinal_check"]);
    for (const name of dropped) expect(added).toContain(name);
    expect(sql).toContain("CHECK (episode_no BETWEEN 1 AND 6)");
    expect(sql).toContain("'concept', 'outline', 'episode:1', 'episode:2', 'episode:3', 'episode:4', 'episode:5', 'episode:6'");
    expect(sql).toContain("CHECK (ordinal BETWEEN 0 AND 7)");
  });

  it("drops only constraints the released migrations created under those default names, with the old ranges", async () => {
    const m2a = await readFile(join(applied, "20260925000100_m2a_text_chain", "migration.sql"), "utf8");
    expect(m2a).toContain("episode_no smallint NOT NULL CHECK (episode_no BETWEEN 1 AND 3),");
    const title = await readFile(join(applied, TITLE_WRITING_MIGRATION, "migration.sql"), "utf8");
    expect(title).toContain("step_key text NOT NULL CHECK (step_key IN ('concept', 'outline', 'episode:1', 'episode:2', 'episode:3')),");
    expect(title).toContain("ordinal smallint NOT NULL CHECK (ordinal BETWEEN 0 AND 4),");
  });

  it("is expressed in the Prisma schema", async () => {
    const schema = await readFile(join(__dirname, "..", "prisma", "schema.prisma"), "utf8");
    const project = [...schema.matchAll(/^model \w+ \{\n([\s\S]*?)\n\}/gm)].map((match) => match[1]!)
      .find((block) => block.includes('@@map("project")'));
    for (const column of EPISODE_PLAN_COLUMNS) expect(project).toContain(`@map("${column}")`);
  });
});

describe("script breakdown migration", () => {
  const migrationPath = join(applied, SCRIPT_BREAKDOWN_MIGRATION, "migration.sql");

  it("follows every released migration; only the independent provider migration sorts after it", async () => {
    const names = (await readdir(applied)).filter((name) => /^\d+_/.test(name)).sort();
    expect(names.slice(0, -2)).toEqual(Object.keys(RELEASED));
    expect(names.slice(-2)).toEqual([SCRIPT_BREAKDOWN_MIGRATION, WRITING_PROVIDER_MIGRATION]);
  });

  it("only expands: adds columns, one table, one index and wider CHECKs, and writes, rewrites or drops no data", async () => {
    const sql = statements(await readFile(migrationPath, "utf8"));
    expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE|DROP TABLE|DROP COLUMN|ALTER COLUMN|RENAME)\b/i);
    // Every new column of an existing table is nullable or has a constant default, so no existing row is rewritten.
    expect(sql).toContain("ALTER TABLE title_writing_run ADD COLUMN run_kind text NOT NULL DEFAULT 'title';");
    for (const column of ["episode_id uuid;", "source_script_revision_id uuid;", "breakdown_save text;"]) {
      expect(sql).toContain(`ALTER TABLE title_writing_run ADD COLUMN ${column}`);
    }
    expect(sql).toContain("ALTER TABLE shot_revision ADD COLUMN planned_duration_ms integer;");
    expect(sql).toContain("CHECK (planned_duration_ms IS NULL OR planned_duration_ms BETWEEN 1000 AND 15000)");
    // Existing runs are title runs with no breakdown columns, which the shape CHECK accepts.
    expect(sql).toContain("(run_kind = 'title' AND episode_id IS NULL AND source_script_revision_id IS NULL AND breakdown_save IS NULL)");
    // The dropped step CHECKs are replaced by wider ones: every old step key and script_save rule still holds.
    expect([...sql.matchAll(/DROP CONSTRAINT (\w+)/g)].map((match) => match[1])).toEqual(["title_writing_step_step_key_check"]);
    expect(sql).toContain("'concept', 'outline', 'episode:1', 'episode:2', 'episode:3', 'episode:4', 'episode:5', 'episode:6', 'breakdown'");
    expect(sql).toContain("CHECK ((script_save IS NULL) = (step_key IN ('concept', 'outline', 'breakdown')))");
    expect(sql).toContain("RAISE EXCEPTION 'expected exactly one script_save step CHECK, found %'");
    expect([...sql.matchAll(/^CREATE TABLE (\w+)/gm)].map((match) => match[1])).toEqual(["script_breakdown_scene"]);
  });

  it("keeps shot revisions immutable, the new column included", async () => {
    const sql = statements(await readFile(migrationPath, "utf8"));
    const m2a = await readFile(join(applied, "20260925000100_m2a_text_chain", "migration.sql"), "utf8");
    const original = /CREATE FUNCTION m2_reject_shot_content_update\(\)[\s\S]*?END \$\$;/.exec(m2a)![0];
    const replaced = /CREATE OR REPLACE FUNCTION m2_reject_shot_content_update\(\)[\s\S]*?END \$\$;/.exec(sql)![0];
    const compared = (text: string) => [...text.matchAll(/NEW\.(\w+) IS DISTINCT FROM OLD\.\1/g)].map((match) => match[1]);
    expect(compared(replaced)).toEqual([...compared(original).slice(0, compared(original).indexOf("duration_hint") + 1), "planned_duration_ms",
      ...compared(original).slice(compared(original).indexOf("duration_hint") + 1)]);
  });

  it("is expressed in the Prisma schema", async () => {
    const schema = await readFile(join(__dirname, "..", "prisma", "schema.prisma"), "utf8");
    const models = [...schema.matchAll(/^model \w+ \{\n([\s\S]*?)\n\}/gm)].map((match) => match[1]!);
    for (const [table, columns] of Object.entries(SCRIPT_BREAKDOWN_COLUMNS)) {
      const model = models.find((block) => block.includes(`@@map("${table}")`));
      expect(model, table).toBeDefined();
      for (const column of columns) {
        const named = model!.includes(`@map("${column}")`) || new RegExp(`^\\s+${column}\\s`, "m").test(model!);
        expect(named, `${table}.${column}`).toBe(true);
      }
    }
  });
});

/** Released migrations and the checksums servers have recorded for them. A change here means a released file changed. */
const RELEASED: Record<string, string> = {
  "20260924000100_m1b_job_core": "15ee68a4d23c82e3078db554c035ca9c29aed894cdb36448324d251432946605",
  "20260925000100_m2a_text_chain": "678ac1aa0afc983d2f94efbe6b2d00fa5bfc0deb8e1a4b55e2911521d8cd1488",
  "20260928000100_script_dependency_scopes": "d10b3314354069aeb6ce4ec0025411fae3cfcae200688fe74b407deb30f117d7",
  "20260928000200_m3a_media_assets": "a8540cb57ec0e9a034ca56ef2c5c9a3ce55a2fdc4076bdabd7e6844c79b26ae2",
  "20260928000300_m3b_job_shot_lineage": "fa3e195e82b760ea3ce8ed39b2daedd2169c8e5de955c5750a5511c8b7073b62",
  "20261008000100_title_writing": "b3931d041dc4f9c1bbaf43fa69e9cfce069465272da9c80173da282271f32671",
  "20261011000100_episode_plan": "93c7f7a0f3236e9a9d08307a59fac02af5bd763851b98ffbec608ce198b424f1",
};
