import { describe, expect, it } from "vitest";
import {
  SERIES_BUDGETS,
  SERIES_JOB_MAX_CALLS,
  SERIES_PROMPT_MAX_CHARS,
  SERIES_REVIEW_CONTENT_CHARS,
  seriesArcSchema,
  seriesBatchCalls,
  seriesBatchCount,
  seriesBatchRange,
  seriesBatchReviewSchema,
  seriesEpisodeSchema,
  seriesJobStageKeys,
  seriesJsonSchema,
  seriesNormalCalls,
  seriesOutlineChunks,
  seriesOutlineLineBudget,
  seriesOutlineSchema,
  seriesPlanCalls,
  seriesReviewShares,
  seriesScopeCalls,
  seriesScopeJobs,
  seriesScopeShapeValid,
  seriesSettingSchema,
  seriesStageBatchNo,
  seriesStageChunkNo,
  seriesStageEpisodeNo,
  seriesStageKind,
  SERIES_STAGE_KEY,
  TITLE_WRITING_MAX_EPISODES,
} from "./index";

const ALL_N = Array.from({ length: 60 }, (_, index) => index + 1);

describe("series call formula: 6 + ceil(N/6) + N + ceil(N/3)", () => {
  it("gives 15 for the 60-episode plan, 19 with episodes 1–3 and their review, 96 for everything", () => {
    expect(seriesPlanCalls(60)).toBe(15);
    expect(seriesPlanCalls(60) + seriesBatchCalls(60, 1)).toBe(19);
    expect(seriesScopeCalls(60, { plan: true, batchFrom: 1, batchTo: 1, final: false })).toBe(19);
    expect(seriesNormalCalls(60)).toBe(96);
    expect(seriesScopeCalls(60, { plan: true, batchFrom: 1, batchTo: 20, final: true })).toBe(96);
  });

  it.each(ALL_N)("N=%i: the jobs of the whole series add up to the formula, and no job needs more than the per-run cap", (n) => {
    const jobs = seriesScopeJobs(n, { plan: true, batchFrom: 1, batchTo: seriesBatchCount(n), final: true });
    expect(jobs.reduce((total, job) => total + job.calls, 0)).toBe(6 + Math.ceil(n / 6) + n + Math.ceil(n / 3));
    expect(jobs.every((job) => job.calls <= SERIES_JOB_MAX_CALLS)).toBe(true);
    expect(seriesOutlineChunks(n)).toBe(Math.ceil(n / 6));
  });

  it("keeps the short-drama limit where it was: the shared constant still says six", () => {
    expect(TITLE_WRITING_MAX_EPISODES).toBe(6);
  });
});

describe("batches, chunks and scopes", () => {
  it("batches are 1–3, 4–6, … and the last one may be shorter; episode numbers are continuous", () => {
    expect(seriesBatchRange(60, 1)).toEqual({ first: 1, last: 3 });
    expect(seriesBatchRange(60, 20)).toEqual({ first: 58, last: 60 });
    expect(seriesBatchRange(7, 3)).toEqual({ first: 7, last: 7 });
    for (const n of ALL_N) {
      const numbers = Array.from({ length: seriesBatchCount(n) }, (_, index) => seriesBatchRange(n, index + 1))
        .flatMap(({ first, last }) => Array.from({ length: last - first + 1 }, (_, offset) => first + offset));
      expect(numbers).toEqual(Array.from({ length: n }, (_, index) => index + 1));
    }
  });

  it("refuses malformed scopes: a final review not after the last batch, reversed or out-of-range batches, nothing at all", () => {
    expect(seriesScopeShapeValid(60, { plan: false, batchFrom: 3, batchTo: 2, final: false })).toBe(false);
    expect(seriesScopeShapeValid(60, { plan: false, batchFrom: 1, batchTo: 21, final: false })).toBe(false);
    expect(seriesScopeShapeValid(60, { plan: false, batchFrom: 1, batchTo: 5, final: true })).toBe(false);
    expect(seriesScopeShapeValid(60, { plan: false, batchFrom: null, batchTo: null, final: false })).toBe(false);
    expect(seriesScopeShapeValid(60, { plan: false, batchFrom: 2, batchTo: null, final: false })).toBe(false);
    expect(seriesScopeShapeValid(60, { plan: false, batchFrom: 2, batchTo: 20, final: true })).toBe(true);
  });
});

describe("stage keys with multi-digit numbers", () => {
  it("reads numbers as numbers and accepts only the grammar", () => {
    expect(seriesStageEpisodeNo("episode:60")).toBe(60);
    expect(seriesStageEpisodeNo("episode:61")).toBeNull();
    expect(seriesStageBatchNo("batch_review:20")).toBe(20);
    expect(seriesStageChunkNo("outline:10")).toBe(10);
    expect(seriesStageKind("batch_review:12")).toBe("batch_review");
    for (const bad of ["episode:0", "episode:07", "outline:11", "batch_review:21", "review:1", "episode:"]) expect(SERIES_STAGE_KEY.test(bad), bad).toBe(false);
    const keys = seriesJobStageKeys(60, "plan", null);
    expect(keys).toEqual(["sources", "research", "directions", "setting", "arc", ...Array.from({ length: 10 }, (_, index) => `outline:${String(index + 1)}`), "plan_review"]);
    expect(keys.length - 1).toBe(seriesPlanCalls(60));
    expect(seriesJobStageKeys(60, "batch", 20)).toEqual(["episode:58", "episode:59", "episode:60", "batch_review:20"]);
  });
});

describe("context budgets", () => {
  it.each(ALL_N)("N=%i: every share is non-negative and every review's texts fit the 28,000-character budget", (n) => {
    const shares = seriesReviewShares(n);
    for (const review of [shares.plan, shares.batch, shares.final]) {
      expect(Object.values(review).every((value) => value >= 0)).toBe(true);
    }
    expect(seriesOutlineLineBudget(n)).toBeGreaterThan(200);
    expect(SERIES_REVIEW_CONTENT_CHARS).toBeLessThan(SERIES_PROMPT_MAX_CHARS);
  });

  it("the writing prompt's texts fit the prompt limit with room for its instructions", () => {
    const b = SERIES_BUDGETS;
    expect(b.setting + b.arc + 3 * b.outlineLineMax + b.ledger + b.handoff).toBeLessThan(SERIES_PROMPT_MAX_CHARS - 10_000);
  });
});

/** Every key path of a JSON Schema, and of a zod object's shape. */
function jsonKeys(schema: unknown, at = ""): string[] {
  const value = schema as { type?: string | string[]; properties?: Record<string, unknown>; items?: unknown };
  if (value.type === "array") return jsonKeys(value.items, `${at}[]`);
  if (!value.properties) return [];
  return Object.entries(value.properties).flatMap(([key, item]) => [at ? `${at}.${key}` : key, ...jsonKeys(item, at ? `${at}.${key}` : key)]);
}

function zodKeys(schema: unknown, at = ""): string[] {
  const def = (schema as { def?: { type: string; shape?: Record<string, unknown>; element?: unknown; innerType?: unknown; in?: unknown } }).def;
  if (!def) return [];
  if (def.type === "nullable" || def.type === "optional" || def.type === "default") return zodKeys(def.innerType, at);
  if (def.type === "pipe") return zodKeys(def.in, at);
  if (def.type === "array") return zodKeys(def.element, `${at}[]`);
  if (def.type !== "object" || !def.shape) return [];
  return Object.entries(def.shape).flatMap(([key, item]) => [at ? `${at}.${key}` : key, ...zodKeys(item, at ? `${at}.${key}` : key)]);
}

describe("the JSON Schemas sent to providers name exactly the zod fields", () => {
  it.each([
    ["setting", seriesSettingSchema(60)],
    ["arc", seriesArcSchema(60)],
    ["outline:10", seriesOutlineSchema(60, 10)],
    ["episode:60", seriesEpisodeSchema(60)],
    ["batch_review:20", seriesBatchReviewSchema],
  ] as const)("%s", (stageKey, zod) => {
    const keys = zodKeys(zod).sort();
    expect(keys.length).toBeGreaterThan(5);
    expect(jsonKeys(seriesJsonSchema(stageKey, 60).schema).sort()).toEqual(keys);
  });
});
