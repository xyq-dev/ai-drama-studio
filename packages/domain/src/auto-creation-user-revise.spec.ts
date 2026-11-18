import { describe, expect, it } from "vitest";
import {
  AUTO_CREATION_REVIEW_SCHEMA,
  type AutoReviewOutput,
  type AutoRunBundle,
  type AutoRunRecord,
  type AutoStageRecord,
} from "@ai-drama/contracts";
import {
  AUTO_USER_REVISE_PATH_VERSION,
  applyBibleSync,
  autoUserRevisionSchema,
  encodeUserReviseDepends,
  normalizeUserBibleSync,
  planAutoUserRevise,
  readUserReviseBrief,
  userReviseIssueBlock,
} from "./auto-creation-user-revise";

function review(overrides: Partial<AutoReviewOutput> = {}): AutoReviewOutput {
  return {
    schema: AUTO_CREATION_REVIEW_SCHEMA,
    checksVersion: "ads.auto-creation.checks.v17",
    verdict: "pass",
    dimensions: [],
    issues: [
      {
        id: "R1", dimension: "conflictAction", severity: "low", target: "episode:1",
        evidence: "沉默几秒就开门", problem: "开门前缺少可见权衡", suggestion: "写清可见犹豫", evidenceVerified: true,
      },
      {
        id: "R2", dimension: "motivation", severity: "low", target: "outline",
        evidence: "逼她承认还放不下", problem: "阻碍者动机应改为误以为争房产", suggestion: "同步大纲与正文动机", evidenceVerified: true,
      },
    ],
    deterministic: [],
    reviewed: { "episode:1": "a".repeat(64) },
    passed: true,
    ...overrides,
  };
}

function bundle(options: { revisionRoundsUsed?: number; callsUsed?: number; callCap?: number; state?: AutoRunRecord["state"] } = {}): AutoRunBundle {
  const run = {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    workspaceId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    projectId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    actorId: "server-owner",
    idempotencyKey: "k",
    inputHash: "a".repeat(64),
    input: {
      schema: "ads.auto-creation.input.v1",
      promptVersion: "ads.auto-creation.prompt.v16",
      selectionRules: "ads.auto-creation.selection-rules.v1",
      checksVersion: "ads.auto-creation.checks.v17",
      idea: "",
      constraints: { genre: "都市情感", audience: "", maxCharacters: null, maxLocations: null, forbiddenThemes: [], endingRequirement: "" },
      materials: [],
      referenceUrls: [],
      researchFetch: false,
      episodeCount: 1,
      episodeSeconds: 60,
      autoStoryboardAfterScripts: false,
      revisionRounds: 2,
      callBudget: 12,
      maxOutputTokens: 4000,
      providerKey: "deepseek",
      model: "deepseek-flash",
      providerAdapter: "deepseek",
      authorization: { mode: "auto", proof: "site_session", initiatedBy: "server-owner", executor: "auto-creation-engine" },
    },
    state: options.state ?? "completed",
    errorCode: null,
    cancelRequestedAt: null,
    executorId: null,
    leaseUntil: null,
    callCap: options.callCap ?? 12,
    callsUsed: options.callsUsed ?? 8,
    revisionRoundsUsed: options.revisionRoundsUsed ?? 0,
    quality: "passed",
    storySave: "saved",
    storyRevisionId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    createdAt: "2026-11-17T00:00:00.000Z",
    updatedAt: "2026-11-17T00:00:00.000Z",
  } as AutoRunRecord;
  const stages: AutoStageRecord[] = [
    { runId: run.id, stageKey: "sources", ordinal: 0, state: "completed", attemptNo: 1, errorCode: null, output: { schema: "ads.auto-creation.sources.v1" } as never, outputHash: "s".repeat(64), dependsOn: {}, scriptSave: null, scriptRevisionId: null, updatedAt: run.updatedAt },
    { runId: run.id, stageKey: "review:1", ordinal: 1, state: "completed", attemptNo: 1, errorCode: null, output: review(), outputHash: "r".repeat(64), dependsOn: {}, scriptSave: null, scriptRevisionId: null, updatedAt: run.updatedAt },
  ];
  return { run, stages, calls: [] };
}

describe("auto-creation user revise planning", () => {
  it("refuses when neither findings nor instruction are provided", () => {
    expect(planAutoUserRevise(bundle(), { findingIds: [], instruction: "  " }).ok).toBe(false);
    expect(planAutoUserRevise(bundle(), { findingIds: [], instruction: "" })).toMatchObject({ code: "empty" });
  });

  it("accepts findings only, instructions only, or both, and always plans the multi-artifact path", () => {
    const findingsOnly = planAutoUserRevise(bundle(), { findingIds: ["R1", "R2"], instruction: "" });
    const instructionOnly = planAutoUserRevise(bundle(), { findingIds: [], instruction: "改周叙动机为误以为争房产" });
    const both = planAutoUserRevise(bundle(), { findingIds: ["R2"], instruction: "并写清开门前的可见犹豫" });
    expect(findingsOnly).toMatchObject({ ok: true, brief: { syncStory: true, episodeTargets: [1], pathVersion: AUTO_USER_REVISE_PATH_VERSION }, quote: { callsNeeded: 2 } });
    expect(instructionOnly).toMatchObject({ ok: true, brief: { syncStory: true, episodeTargets: [1] }, quote: { callsNeeded: 2, roundsRemainingAfter: 1 } });
    expect(both).toMatchObject({ ok: true, brief: { findingIds: ["R2"], syncStory: true } });
    if (findingsOnly.ok && both.ok) {
      const lines = userReviseIssueBlock(review(), findingsOnly.brief, 1);
      expect(lines.some((item) => item.target === "outline")).toBe(true);
      expect(lines.some((item) => item.target === "episode:1")).toBe(true);
      expect(userReviseIssueBlock(review(), both.brief, 1).some((item) => item.ids.includes("U1"))).toBe(true);
    }
  });

  it("refuses when rounds or call budget cannot cover revise+review", () => {
    expect(planAutoUserRevise(bundle({ revisionRoundsUsed: 2 }), { findingIds: ["R1"], instruction: "" })).toMatchObject({ code: "rounds_exhausted" });
    expect(planAutoUserRevise(bundle({ callsUsed: 11, callCap: 12 }), { findingIds: ["R1"], instruction: "" })).toMatchObject({ code: "budget_exhausted" });
  });

  it("refuses when selected findings cover more episodes than one revise round allows", () => {
    const many = review({
      issues: [
        { id: "R1", dimension: "conflictAction", severity: "low", target: "episode:1",
          evidence: "e1", problem: "p1", suggestion: "s1", evidenceVerified: true },
        { id: "R2", dimension: "conflictAction", severity: "low", target: "episode:2",
          evidence: "e2", problem: "p2", suggestion: "s2", evidenceVerified: true },
        { id: "R3", dimension: "conflictAction", severity: "low", target: "episode:3",
          evidence: "e3", problem: "p3", suggestion: "s3", evidenceVerified: true },
        { id: "R4", dimension: "conflictAction", severity: "low", target: "episode:4",
          evidence: "e4", problem: "p4", suggestion: "s4", evidenceVerified: true },
      ],
    });
    const big = bundle();
    big.run.input.episodeCount = 6;
    big.stages[1]!.output = many;
    expect(planAutoUserRevise(big, { findingIds: ["R1", "R2", "R3", "R4"], instruction: "" }))
      .toMatchObject({ ok: false, code: "too_many_episodes" });
  });

  it("round-trips the brief through depends_on without a migration", () => {
    const planned = planAutoUserRevise(bundle(), { findingIds: ["R2"], instruction: "同步阻碍" });
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    const encoded = encodeUserReviseDepends(planned.brief);
    expect(readUserReviseBrief(encoded)).toEqual(planned.brief);
    expect(readUserReviseBrief({ other: "x" })).toBeNull();
  });

  it("accepts null bibleSync and ignores null nested fields for OpenAI-strict answers", () => {
    expect(normalizeUserBibleSync(null)).toBeUndefined();
    expect(normalizeUserBibleSync({ logline: null, synopsis: null, obstacles: null, keyChoices: null })).toBeUndefined();
    expect(normalizeUserBibleSync({ obstacles: ["误以为争房产"], logline: null })).toEqual({ obstacles: ["误以为争房产"] });
    const bible = {
      schema: "ads.auto-creation.bible.v1", title: "t", logline: "旧一句话", synopsis: "旧梗概",
      characters: [], locations: [], relationships: [], props: [],
      story: { desire: "d", weakness: "w", wound: "w", lie: "l", need: "n", stakes: "s",
        obstacles: ["旧阻碍"], keyChoices: [{ choice: "c", consequence: "q" }], ending: "e" },
    } as never;
    expect(applyBibleSync(bible, null).story.obstacles).toEqual(["旧阻碍"]);
    expect(applyBibleSync(bible, { obstacles: ["新阻碍"], logline: null, synopsis: null, keyChoices: null }).story.obstacles)
      .toEqual(["新阻碍"]);
    expect(autoUserRevisionSchema(1).shape.bibleSync.safeParse(null).success).toBe(true);
  });
});
