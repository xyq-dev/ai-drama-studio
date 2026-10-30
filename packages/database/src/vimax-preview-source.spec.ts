import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { VimaxPreviewSourceStore } from "./vimax-preview-source";
import type { DatabasePool } from "./job-service";

const W = "11111111-1111-4111-8111-111111111111";
const P = "22222222-2222-4222-8222-222222222222";
const E = "33333333-3333-4333-8333-333333333333";
const S = "44444444-4444-4444-8444-444444444444";
const C = "55555555-5555-4555-8555-555555555555";
const R = "66666666-6666-4666-8666-666666666666";
const TEXT = "【场景】车站\r\n【动作】林夏望着远处。\r\n林夏：等我。\r\n";
type Row = Record<string, unknown>;

function setup(options: {
  project?: Row | null; episode?: Row | null; script?: Row | null; characters?: Row[]; error?: boolean;
} = {}) {
  const project = options.project === undefined ? { writing_mode: "short" } : options.project;
  const episode = options.episode === undefined ? { episode_no: 1, current_script_revision_id: S, approved_script_revision_id: S } : options.episode;
  const script = options.script === undefined
    ? { revision_no: 3, content_json: { text: TEXT }, content_hash: "not-the-raw-text-hash", review_status: "APPROVED", freshness_status: "CURRENT" }
    : options.script;
  const characters = options.characters ?? [{ id: C, current_revision_id: R, revision_id: R, name: "林夏", freshness_status: "CURRENT" }];
  const calls: Array<{ sql: string; values?: unknown[] }> = [];
  const release = vi.fn();
  const query = vi.fn(async (sql: string, values?: unknown[]) => {
    calls.push({ sql, ...(values ? { values } : {}) });
    // Any newly introduced write or row lock fails these tests, including on refusal/error paths.
    if (!/^(SELECT|BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY|ROLLBACK)/.test(sql.trim())
      || /\bFOR\s+(UPDATE|SHARE)\b/i.test(sql)) throw new Error("write/lock attempted in preview");
    if (sql.includes("FROM project")) return { rows: project ? [project] : [] };
    if (sql.includes("FROM episode")) return { rows: episode ? [episode] : [] };
    if (sql.includes("FROM script_revision")) {
      if (options.error) throw new Error("database unavailable");
      return { rows: script ? [script] : [] };
    }
    if (sql.includes("FROM character c")) return { rows: characters };
    return { rows: [] };
  });
  const connect = vi.fn(async () => ({ query, release }));
  const store = new VimaxPreviewSourceStore({ connect } as unknown as DatabasePool);
  return { store, calls, release, query };
}

describe("ViMax platform source is a scoped read-only database snapshot", () => {
  it("returns exact text, its raw UTF-8 hash and stable character identities without a write", async () => {
    const { store, calls, release } = setup();
    const result = await store.read(W, P, E);
    expect(result).toEqual({ kind: "ok", source: {
      schema: "ads.vimax-platform-source.v1", projectId: P, episodeId: E, episodeNo: 1,
      scriptRevisionId: S, scriptRevisionNo: 3, scriptText: TEXT,
      scriptContentHash: createHash("sha256").update(TEXT, "utf8").digest("hex"),
      characters: [{ key: "C1", characterId: C, revisionId: R, name: "林夏" }],
    } });
    expect(calls[0]!.sql).toBe("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    expect(calls.at(-1)!.sql).toBe("ROLLBACK");
    expect(calls.find(({ sql }) => sql.includes("FROM project"))!.values).toEqual([P, W]);
    expect(calls.find(({ sql }) => sql.includes("FROM episode"))!.values).toEqual([E, P, W]);
    expect(calls.find(({ sql }) => sql.includes("FROM script_revision"))!.values).toEqual([S, E, P, W]);
    expect(calls.find(({ sql }) => sql.includes("FROM character c"))!.values).toEqual([P, W, 31]);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it.each([{ project: null }, { episode: null }])("never exposes another scope's data (%o)", async (options) => {
    const { store, calls, release } = setup(options);
    expect(await store.read(W, P, E)).toEqual({ kind: "not_found" });
    expect(calls.at(-1)!.sql).toBe("ROLLBACK");
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("refuses series before reading scripts or roles", async () => {
    const { store, calls } = setup({ project: { writing_mode: "series" } });
    expect(await store.read(W, P, E)).toEqual({ kind: "series_not_enabled" });
    expect(calls).toHaveLength(3);
  });

  it.each([
    { episode: { episode_no: 1, current_script_revision_id: null, approved_script_revision_id: null } },
    { episode: { episode_no: 1, current_script_revision_id: S, approved_script_revision_id: R } },
    { script: null },
    { script: { content_json: { text: TEXT }, review_status: "IN_REVIEW", freshness_status: "CURRENT" } },
    { script: { content_json: { text: TEXT }, review_status: "APPROVED", freshness_status: "STALE" } },
  ])("refuses missing, unapproved and stale current scripts (%o)", async (options) => {
    const { store } = setup(options);
    expect(await store.read(W, P, E)).toEqual({ kind: "script_review_required" });
  });

  it.each([{ scene: "unsupported" }, { text: "" }, { text: "a".repeat(20_001) }, { text: "bad\u0000text" }])(
    "never rewrites or truncates unsupported source content (%o)", async (content_json) => {
      const { store } = setup({ script: { revision_no: 1, content_json, review_status: "APPROVED", freshness_status: "CURRENT" } });
      expect(await store.read(W, P, E)).toEqual({ kind: "script_unsupported" });
    },
  );

  it("refuses 31 characters instead of silently choosing 30", async () => {
    const { store } = setup({ characters: Array.from({ length: 31 }, () => ({ id: C })) });
    expect(await store.read(W, P, E)).toEqual({ kind: "too_many_characters" });
  });

  it.each([
    { id: C, current_revision_id: R, revision_id: R, freshness_status: "STALE", name: "林夏" },
    { id: C, current_revision_id: null, revision_id: null, freshness_status: null, name: "林夏" },
    { id: C, current_revision_id: R, revision_id: R, freshness_status: "CURRENT", name: "名".repeat(21) },
  ])("refuses unready characters instead of removing them (%o)", async (character) => {
    const { store } = setup({ characters: [character] });
    expect(await store.read(W, P, E)).toEqual({ kind: "characters_unsupported" });
  });

  it("propagates database failure while rolling back and releasing its connection", async () => {
    const { store, calls, release } = setup({ error: true });
    await expect(store.read(W, P, E)).rejects.toThrow("database unavailable");
    expect(calls.at(-1)!.sql).toBe("ROLLBACK");
    expect(release).toHaveBeenCalledTimes(1);
  });
});
