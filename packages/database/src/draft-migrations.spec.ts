import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

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

  it("keeps the title writing draft unapplied, additive, and without a cost amount", async () => {
    const appliedNames = await readdir(applied);
    expect(appliedNames.some((name) => name.includes("title_writing"))).toBe(false);
    const draft = await readFile(join(drafts, "20261008000100_title_writing.sql"), "utf8");
    expect(draft).toContain("Do not apply");
    expect(draft).not.toMatch(/^\s*(ALTER|UPDATE|DELETE|DROP|TRUNCATE)\b/im);
    expect(draft).toContain("UNIQUE (workspace_id, actor_id, idempotency_key)");
    expect(draft).toContain("WHERE state = 'running'");
    expect(draft).toContain("CHECK (billing_status = 'unknown')");
    expect(draft).not.toMatch(/amount\w*\s+(numeric|decimal)/i);
    expect(draft).not.toContain("qwen_writing_request");
  });
});
