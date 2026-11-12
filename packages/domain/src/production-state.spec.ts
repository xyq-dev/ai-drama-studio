import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  appendApprovalEvent,
  parseProductionState,
  productionReadiness,
  validateProductionStateSemantics,
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

  it("blocks formal production when modelPolicy has no active lock", async () => {
    const state = await fixture();
    state.modelPolicy.activeLockedVersionId = null;

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
      initial.modelPolicy.activeLockedVersionId = null;
      await writeProductionStateFile(file, initial);

      const next = clone(initial);
      next.modelPolicy.activeLockedVersionId = next.modelPolicy.currentVersionId;
      await expect(writeProductionStateFile(file, next)).rejects.toMatchObject({
        code: "APPROVAL_EVENT_REQUIRED",
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
