import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  appendApprovalEvent,
  assertProductionStateUpdate,
  parseProductionState,
  productionReadiness,
  takeGenerationReadiness,
  validateProductionStateSemantics,
  validateProductionStateStructure,
  writeProductionStateFile,
} from "./production-state";

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

async function fixture() {
  const path = resolve(__dirname, "../../../docs/fixtures/hongguo-production-state.v1.minimal.json");
  return parseProductionState(JSON.parse(await readFile(path, "utf8")) as unknown);
}

describe("production state v1", () => {
  it("accepts the finalized minimal fixture and ignores unrelated future characters", async () => {
    const state = await fixture();
    const validation = validateProductionStateSemantics(state);
    expect(validation).toEqual({ valid: true, issues: [] });

    const gate = productionReadiness(state, "S1");
    expect(gate.allowed).toBe(true);
    expect(gate.visualCharacterIds).toEqual(["alan", "dual", "zhou"]);
    expect(gate.voiceCharacterIds).toEqual(["alan", "zhou"]);
    expect(gate.blockers).toEqual([]);
  });

  it("uses the v1 JSON Schema contract for structural validation", async () => {
    const state = await fixture();
    const raw = clone(state) as unknown as Record<string, unknown>;
    delete raw.spec;

    const missing = validateProductionStateStructure(raw);
    expect(missing.valid).toBe(false);
    expect(missing.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "SCHEMA_REQUIRED_MISSING", path: "$.spec" }),
    ]));

    const extra = clone(state) as unknown as Record<string, unknown>;
    extra.unplannedField = true;
    const unexpected = validateProductionStateStructure(extra);
    expect(unexpected.valid).toBe(false);
    expect(unexpected.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "SCHEMA_ADDITIONAL_PROPERTY", path: "$.unplannedField" }),
    ]));
  });

  it("blocks formal production when modelPolicy has no active lock", async () => {
    const state = await fixture();
    const policy = state.modelPolicy.versions[0]!;
    state.modelPolicy.activeLockedVersionId = null;
    policy.status = "draft";
    policy.effectiveAt = null;
    policy.approvedBy = null;
    policy.budget.currency = null;
    policy.budget.maxCostPerTake = null;
    policy.budget.maxTakesPerShot = null;
    policy.budget.maxExperimentalCostPerEpisode = null;

    const gate = productionReadiness(state, "S1");
    expect(gate.allowed).toBe(false);
    expect(gate.blockers).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "MODEL_POLICY_LOCK_MISSING" }),
    ]));
  });

  it("only requires Look or Voice for characters actually referenced by this episode", async () => {
    const state = await fixture();
    const storyboard = state.episodes[0]!.storyboard!;
    const active = storyboard.versions.find((version) => version.versionId === storyboard.activeLockedVersionId)!;
    active.referencedCharacterIds = ["alan", "zhou", "dual", "chen"];

    const gate = productionReadiness(state, "S1");
    expect(gate.allowed).toBe(false);
    expect(gate.blockers).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "CHARACTER_LOOK_LOCK_MISSING", characterId: "chen" }),
    ]));
    expect(gate.blockers).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "CHARACTER_VOICE_LOCK_MISSING", characterId: "dual" }),
    ]));
  });

  it("rejects active pointers that do not point to a locked version in the same container", async () => {
    const state = await fixture();
    state.bible.activeLockedVersionId = "fixture/series/bible/missing";

    const validation = validateProductionStateSemantics(state);
    expect(validation.valid).toBe(false);
    expect(validation.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "ACTIVE_LOCKED_VERSION_MISSING", path: "bible.activeLockedVersionId" }),
    ]));
  });

  it("requires a locked current version to be the active locked version", async () => {
    const state = await fixture();
    state.episodes[0]!.script.currentVersionId = "fixture/S1/script/v1";

    const validation = validateProductionStateSemantics(state);
    expect(validation.valid).toBe(false);
    expect(validation.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "CURRENT_LOCKED_VERSION_NOT_ACTIVE" }),
    ]));
  });

  it("rejects supersedes cycles", async () => {
    const state = await fixture();
    const script = state.episodes[0]!.script;
    script.versions[0]!.supersedes = "fixture/S1/script/v2";

    const validation = validateProductionStateSemantics(state);
    expect(validation.valid).toBe(false);
    expect(validation.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "SUPERSEDES_CYCLE" }),
    ]));
  });

  it("does not allow an experimental Take to back a locked ShotVersion", async () => {
    const state = await fixture();
    state.episodes[0]!.shots[0]!.versions[0]!.takes[0]!.modelPool = "experimental";

    const validation = validateProductionStateSemantics(state);
    expect(validation.valid).toBe(false);
    expect(validation.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "LOCKED_SHOT_EXPERIMENTAL_TAKE" }),
    ]));
  });

  it("requires a selected production Take when a ShotVersion is locked", async () => {
    const state = await fixture();
    const version = state.episodes[0]!.shots[0]!.versions[0]!;
    version.selectedTakeId = null;
    version.takes[0]!.status = "not_selected";

    const validation = validateProductionStateSemantics(state);
    expect(validation.valid).toBe(false);
    expect(validation.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "LOCKED_SHOT_TAKE_MISSING" }),
    ]));
  });

  it("requires complete user-approved budget gates for every locked modelPolicy", async () => {
    const state = await fixture();
    state.modelPolicy.versions[0]!.budget.maxCostPerTake = null;
    state.modelPolicy.versions[0]!.approvedBy = null;

    const validation = validateProductionStateSemantics(state);
    expect(validation.valid).toBe(false);
    expect(validation.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "LOCKED_POLICY_BUDGET_INCOMPLETE" }),
      expect.objectContaining({ code: "LOCKED_POLICY_NOT_USER_APPROVED" }),
    ]));
  });

  it("enforces approval actor ownership", async () => {
    const state = await fixture();
    state.approvalLog.push({
      eventId: "ae-invalid-lock",
      action: "lock",
      objectType: "script",
      objectId: "S1",
      versionId: "fixture/S1/script/v2",
      fromStatus: "review",
      toStatus: "locked",
      actor: "qa",
      timestamp: "2026-11-12T16:00:00+08:00",
    });

    const validation = validateProductionStateSemantics(state);
    expect(validation.valid).toBe(false);
    expect(validation.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "APPROVAL_ACTOR_INVALID" }),
    ]));
  });

  it("enforces the locked production model and per-Take budget before generation", async () => {
    const state = await fixture();

    expect(takeGenerationReadiness(state, {
      episodeId: "S1",
      shotId: "S1-01",
      shotVersionId: "S1-01/v1",
      modelPool: "production",
      capability: "video",
      model: "example-video-model",
      estimatedCost: 5,
    }).allowed).toBe(true);

    const wrongModel = takeGenerationReadiness(state, {
      episodeId: "S1",
      shotId: "S1-01",
      shotVersionId: "S1-01/v1",
      modelPool: "production",
      capability: "video",
      model: "another-model",
      estimatedCost: 5,
    });
    expect(wrongModel.blockers).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "PRODUCTION_MODEL_MISMATCH" }),
    ]));

    const overBudget = takeGenerationReadiness(state, {
      episodeId: "S1",
      shotId: "S1-01",
      shotVersionId: "S1-01/v1",
      modelPool: "production",
      capability: "video",
      model: "example-video-model",
      estimatedCost: 11,
    });
    expect(overBudget.blockers).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "MAX_COST_PER_TAKE_EXCEEDED" }),
    ]));
  });

  it("blocks experimental generation unless the pool and budget explicitly allow it", async () => {
    const state = await fixture();

    const disabled = takeGenerationReadiness(state, {
      episodeId: "S1",
      shotId: "S1-01",
      shotVersionId: "S1-01/v1",
      modelPool: "experimental",
      capability: "video",
      model: "trial-video-model",
      estimatedCost: 1,
    });
    expect(disabled.blockers).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "EXPERIMENTAL_POOL_DISABLED" }),
      expect.objectContaining({ code: "EXPERIMENTAL_MODEL_NOT_ALLOWED" }),
      expect.objectContaining({ code: "EXPERIMENTAL_EPISODE_BUDGET_EXCEEDED" }),
    ]));

    const unknown = takeGenerationReadiness(state, {
      episodeId: "S1",
      shotId: "S1-01",
      shotVersionId: "S1-01/v1",
      modelPool: "production",
      capability: "video",
      model: "example-video-model",
      estimatedCost: "unknown",
    });
    expect(unknown.blockers).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "UNKNOWN_COST_REQUIRES_APPROVAL" }),
    ]));
  });

  it("requires lock and selection approvals for a newly added locked ShotVersion", async () => {
    const previous = await fixture();
    const next = clone(previous);
    const shot = next.episodes[0]!.shots[0]!;
    const source = clone(shot.versions[0]!);
    source.versionId = "S1-01/v2";
    source.supersedes = "S1-01/v1";
    source.selectedTakeId = "S1-01/v2/t1";
    source.takes[0]!.takeId = "S1-01/v2/t1";
    shot.versions.push(source);

    expect(() => assertProductionStateUpdate(previous, next)).toThrowError(
      expect.objectContaining({ code: "APPROVAL_EVENT_REQUIRED" }),
    );

    next.approvalLog.push({
      eventId: "ae-shot-v2-lock",
      action: "lock",
      objectType: "shot",
      objectId: "S1-01",
      versionId: "S1-01/v2",
      fromStatus: "review",
      toStatus: "locked",
      actor: "user",
      timestamp: "2026-11-12T17:20:00+08:00",
    });
    expect(() => assertProductionStateUpdate(previous, next)).toThrowError(
      expect.objectContaining({ code: "APPROVAL_EVENT_REQUIRED" }),
    );

    next.approvalLog.push({
      eventId: "ae-shot-v2-select",
      action: "select_take",
      objectType: "shot",
      objectId: "S1-01",
      versionId: "S1-01/v2",
      fromStatus: null,
      toStatus: null,
      actor: "user",
      timestamp: "2026-11-12T17:21:00+08:00",
    });
    expect(() => assertProductionStateUpdate(previous, next)).not.toThrow();
  });

  it("requires user approval when a newly introduced character Look is already locked", async () => {
    const previous = await fixture();
    const next = clone(previous);
    next.characters.push({
      characterId: "new-role",
      name: "新角色",
      look: {
        currentVersionId: "fixture/series/look/new-role/v1",
        activeLockedVersionId: "fixture/series/look/new-role/v1",
        versions: [{
          versionId: "fixture/series/look/new-role/v1",
          status: "locked",
          lockedAt: "2026-11-12T17:20:00+08:00",
          lockedBy: "user",
        }],
      },
    });

    expect(() => assertProductionStateUpdate(previous, next)).toThrowError(
      expect.objectContaining({ code: "APPROVAL_EVENT_REQUIRED" }),
    );
  });

  it("preserves draft and review versions instead of allowing history deletion", async () => {
    const previous = await fixture();
    const script = previous.episodes[0]!.script;
    script.versions.push({ versionId: "fixture/S1/script/v3", status: "draft" });
    script.currentVersionId = "fixture/S1/script/v3";

    const next = clone(previous);
    next.episodes[0]!.script.versions = next.episodes[0]!.script.versions.filter(
      (version) => version.versionId !== "fixture/S1/script/v3",
    );
    next.episodes[0]!.script.currentVersionId = "fixture/S1/script/v2";

    expect(() => assertProductionStateUpdate(previous, next)).toThrowError(
      expect.objectContaining({ code: "VERSION_HISTORY_DELETE_FORBIDDEN" }),
    );
  });

  it("does not allow historical QA not_scored checks to be rewritten as pass", async () => {
    const previous = await fixture();
    previous.episodes[0]!.qa[0]!.checks.visual.result = "not_scored";
    const next = clone(previous);
    next.episodes[0]!.qa[0]!.checks.visual.result = "pass";

    expect(() => assertProductionStateUpdate(previous, next)).toThrowError(
      expect.objectContaining({ code: "QA_NOT_SCORED_REWRITE_FORBIDDEN" }),
    );
  });

  it("counts Takes across all ShotVersions for maxTakesPerShot", async () => {
    const state = await fixture();
    state.modelPolicy.versions[0]!.budget.maxTakesPerShot = 1;
    const shot = state.episodes[0]!.shots[0]!;
    shot.versions.push({
      versionId: "S1-01/v2",
      status: "draft",
      selectedTakeId: null,
      takes: [],
    });
    shot.currentVersionId = "S1-01/v2";

    const gate = takeGenerationReadiness(state, {
      episodeId: "S1",
      shotId: "S1-01",
      shotVersionId: "S1-01/v2",
      modelPool: "production",
      capability: "video",
      model: "example-video-model",
      estimatedCost: 1,
    });
    expect(gate.blockers).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "MAX_TAKES_PER_SHOT_REACHED" }),
    ]));
  });

  it("rejects negative and non-finite numeric cost estimates", async () => {
    const state = await fixture();

    for (const estimatedCost of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const gate = takeGenerationReadiness(state, {
        episodeId: "S1",
        shotId: "S1-01",
        shotVersionId: "S1-01/v1",
        modelPool: "production",
        capability: "video",
        model: "example-video-model",
        estimatedCost,
      });
      expect(gate.blockers).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "INVALID_ESTIMATED_COST" }),
      ]));
    }
  });

  it("rejects concurrent writers while a production-state file lock is held", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "hongguo-state-lock-"));
    const file = resolve(directory, "production-state.json");
    try {
      await writeFile(file + ".lock", "held", "utf8");
      await expect(writeProductionStateFile(file, await fixture())).rejects.toMatchObject({
        code: "PRODUCTION_STATE_WRITE_CONFLICT",
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("appends approval events without rewriting history", async () => {
    const state = await fixture();
    const next = appendApprovalEvent(state, {
      eventId: "ae-new-review",
      action: "request_revision",
      objectType: "script",
      objectId: "S1",
      versionId: "fixture/S1/script/v2",
      fromStatus: "locked",
      toStatus: "revision",
      actor: "user",
      sourceQuote: "重做这一版",
      timestamp: "2026-11-12T17:00:00+08:00",
    });
    expect(next.approvalLog).toHaveLength(state.approvalLog.length + 1);
    expect(state.approvalLog).toHaveLength(1);
    expect(next.updatedAt).toBe("2026-11-12T17:00:00+08:00");
    expect(() => appendApprovalEvent(next, next.approvalLog.at(-1))).toThrowError(
      expect.objectContaining({ code: "APPROVAL_EVENT_DUPLICATE" }),
    );
  });

  it("writes a new state atomically and refuses to rewrite a previously locked version", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "hongguo-state-"));
    const file = resolve(directory, "production-state.json");
    try {
      const state = await fixture();
      await writeProductionStateFile(file, state);
      expect(JSON.parse(await readFile(file, "utf8")).schema).toBe("hongguo-production-state.v1");

      const changed = clone(state);
      changed.bible.versions[0]!.path = "/tmp/rewritten-bible.md";
      await expect(writeProductionStateFile(file, changed)).rejects.toMatchObject({
        code: "LOCKED_VERSION_REWRITE_FORBIDDEN",
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("requires a fresh user ApprovalEvent before changing an active lock pointer", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "hongguo-state-pointer-"));
    const file = resolve(directory, "production-state.json");
    try {
      const initial = await fixture();
      const initialPolicy = initial.modelPolicy.versions[0]!;
      initial.modelPolicy.activeLockedVersionId = null;
      initialPolicy.status = "review";
      initialPolicy.effectiveAt = null;
      initialPolicy.approvedBy = null;
      await writeProductionStateFile(file, initial);

      const next = clone(initial);
      const nextPolicy = next.modelPolicy.versions[0]!;
      nextPolicy.status = "locked";
      nextPolicy.effectiveAt = "2026-11-12T17:30:00+08:00";
      nextPolicy.approvedBy = "user";
      next.modelPolicy.activeLockedVersionId = next.modelPolicy.currentVersionId;
      await expect(writeProductionStateFile(file, next)).rejects.toMatchObject({
        code: "APPROVAL_EVENT_REQUIRED",
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
