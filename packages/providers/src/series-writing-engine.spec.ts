import { describe, expect, it } from "vitest";
import { SERIES_PROMPT_MAX_CHARS, seriesNormalCalls, seriesPlanCalls } from "@ai-drama/contracts";
import { ALL, seriesSetup } from "./series-writing-test-kit";

/**
 * Series writing offline acceptance (model double only; every answer is the double's synthetic sample). No real model,
 * image, voice or video service is called.
 */

describe("A. a complete 60-episode series: plan, every batch, every batch review, the final structural review", () => {
  it("sends exactly 6 + ceil(N/6) + N + ceil(N/3) = 96 calls, each prompt within 40,000 characters", async () => {
    const { seen, view, store, grant } = await seriesSetup();
    const created = await grant(ALL(60));
    expect(created.kind).toBe("created");
    const result = await view();
    expect(seriesNormalCalls(60)).toBe(96);
    expect(store.calls).toHaveLength(96);
    expect(seen).toHaveLength(96);
    expect(result.completion).toBe("text_complete");
    expect(result.written).toBe(60);
    expect(result.episodes.map((item) => item.episodeNo)).toEqual(Array.from({ length: 60 }, (_, index) => index + 1));
    expect(result.batches.every((item) => item.review.status === "passed" && item.ledger.status === "valid")).toBe(true);
    expect(result.final.status).toBe("passed");
    for (const exchange of seen) expect(exchange.user.length + exchange.system.length).toBeLessThanOrEqual(SERIES_PROMPT_MAX_CHARS);
    // Every stage was sent once: no repeated research, generation or save.
    const stages = seen.map((item) => item.stage);
    expect(new Set(stages).size).toBe(96);
    expect(stages.filter((item) => item.startsWith("outline:"))).toHaveLength(10);
    expect(stages.filter((item) => item.startsWith("batch_review:"))).toHaveLength(20);
    expect(stages).toContain("episode:60");
    expect(stages.indexOf("episode:10")).toBeGreaterThan(stages.indexOf("episode:9"));
    expect(result.grants[0]).toMatchObject({ callsUsed: 96, callBudget: 96, state: "completed" });
    expect(store.plans).toHaveLength(1);
    expect(store.ledgers).toHaveLength(20);
    expect(store.jobs.every((job) => job.callCap <= 60)).toBe(true);
    expect(store.jobs[0]!.callCap).toBe(seriesPlanCalls(60));
  });
});
