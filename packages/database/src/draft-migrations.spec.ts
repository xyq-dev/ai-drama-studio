import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TITLE_WRITING_MIGRATION, TITLE_WRITING_TABLES } from "./title-writing-store";

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

  it("is applied after every released migration, and the draft is marked superseded and not applied", async () => {
    const names = (await readdir(applied)).filter((name) => /^\d+_/.test(name)).sort();
    expect(names.at(-1)).toBe(TITLE_WRITING_MIGRATION);
    expect(names).toEqual([...Object.keys(RELEASED), TITLE_WRITING_MIGRATION]);
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
    for (const [table, columns] of Object.entries(TITLE_WRITING_TABLES)) {
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

/** Released migrations and the checksums servers have recorded for them. A change here means a released file changed. */
const RELEASED: Record<string, string> = {
  "20260924000100_m1b_job_core": "15ee68a4d23c82e3078db554c035ca9c29aed894cdb36448324d251432946605",
  "20260925000100_m2a_text_chain": "678ac1aa0afc983d2f94efbe6b2d00fa5bfc0deb8e1a4b55e2911521d8cd1488",
  "20260928000100_script_dependency_scopes": "d10b3314354069aeb6ce4ec0025411fae3cfcae200688fe74b407deb30f117d7",
  "20260928000200_m3a_media_assets": "a8540cb57ec0e9a034ca56ef2c5c9a3ce55a2fdc4076bdabd7e6844c79b26ae2",
  "20260928000300_m3b_job_shot_lineage": "fa3e195e82b760ea3ce8ed39b2daedd2169c8e5de955c5750a5511c8b7073b62",
};
