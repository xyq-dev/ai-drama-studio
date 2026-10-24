import { describe, expect, it } from "vitest";
import { writingWorkspaceIdle } from "./writing-activation";

/**
 * The activation probe against a fake database: which optional tables exist and which hold running work. Every optional
 * table is probed on its own; a missing one is skipped, never read as "the whole workspace is idle".
 */
type Table = "title_writing_run" | "writing_candidate_request" | "auto_creation_run" | "series_writing_run";

function fakePool(present: readonly Table[], busy: readonly Table[] = [], failing: Table | null = null) {
  const asked: string[] = [];
  return {
    asked,
    query: async (sql: string) => {
      asked.push(sql);
      const probed = /to_regclass\('(\w+)'\)/.exec(sql)?.[1] as Table | undefined;
      if (probed) {
        if (probed === failing) return { rows: [] };
        return { rows: [{ missing: !present.includes(probed) }] };
      }
      const read = (["title_writing_run", "writing_candidate_request", "auto_creation_run", "series_writing_run"] as const).find((table) => sql.includes(`FROM ${table}`));
      if (!read) throw new Error(`unexpected query: ${sql}`);
      const value = busy.includes(read);
      return { rows: [{ running: value, busy: value }] };
    },
  };
}

const BASE: Table[] = ["title_writing_run"];

describe("model configuration activation waits for every running writing task", () => {
  it("base + series, no automatic creation table, a series job running: not idle", async () => {
    expect(await writingWorkspaceIdle(fakePool([...BASE, "series_writing_run"], ["series_writing_run"]), "w")).toBe(false);
  });

  it.each([
    ["base only", BASE, [], true],
    ["base + series, nothing running", [...BASE, "series_writing_run"], [], true],
    ["base + automatic creation, a run running", [...BASE, "auto_creation_run"], ["auto_creation_run"], false],
    ["base + automatic creation + series, only series running", [...BASE, "auto_creation_run", "series_writing_run"], ["series_writing_run"], false],
    ["base + automatic creation + series, only automatic creation running", [...BASE, "auto_creation_run", "series_writing_run"], ["auto_creation_run"], false],
    ["base + candidates + series, an open candidate", [...BASE, "writing_candidate_request", "series_writing_run"], ["writing_candidate_request"], false],
    ["every table, nothing running", [...BASE, "writing_candidate_request", "auto_creation_run", "series_writing_run"], [], true],
    ["a title writing run", BASE, ["title_writing_run"], false],
  ] as Array<[string, Table[], Table[], boolean]>)("%s", async (_label, present, busy, idle) => {
    expect(await writingWorkspaceIdle(fakePool(present, busy), "w")).toBe(idle);
  });

  it("a probe that answers nothing is an error, never idle", async () => {
    await expect(writingWorkspaceIdle(fakePool([...BASE, "series_writing_run"], [], "series_writing_run"), "w")).rejects.toThrow(/probe unavailable/);
    await expect(writingWorkspaceIdle(fakePool([...BASE, "auto_creation_run"], [], "auto_creation_run"), "w")).rejects.toThrow(/probe unavailable/);
  });
});
