// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { VIMAX_CANDIDATE_PLACE_SHOTS_SCHEMA, VIMAX_CANDIDATE_SAVE_SCENE_SCHEMA } from "@ai-drama/contracts";
import { clearVimaxCandidatePending, readVimaxCandidatePending, writeVimaxCandidatePending, type VimaxCandidatePending } from "./vimax-candidate-pending";
import { vimaxCandidateFixture } from "./vimax-candidate-test-fixtures";

beforeEach(() => { window.sessionStorage.clear(); vi.restoreAllMocks(); });
const keyFor = (p: string, e: string) => `ads:vimax-candidate:${p}:${e}:v1`;
function cases(): VimaxCandidatePending[] {
  const f = vimaxCandidateFixture();
  return [{ kind: "create", key: f.createKey, body: f.create },
    { kind: "save_scene", key: f.sceneKey, candidateId: f.candidateId,
      body: { schema: VIMAX_CANDIDATE_SAVE_SCENE_SCHEMA, expectedVersion: 1, confirmedReview: true } },
    { kind: "place_shots", key: f.shotsKey, candidateId: f.candidateId,
      body: { schema: VIMAX_CANDIDATE_PLACE_SHOTS_SCHEMA, expectedVersion: 2, confirmedReview: true } }];
}

describe("Vimax candidate pending write identity", () => {
  it.each([0, 1, 2])("retains the complete original kind/body/key in this tab until its exact acknowledgement (%i)", (index) => {
    const f = vimaxCandidateFixture(); const pending = cases()[index]!;
    writeVimaxCandidatePending(f.source.projectId, f.source.episodeId, pending);
    expect(readVimaxCandidatePending(f.source.projectId, f.source.episodeId)).toEqual(pending);
    expect(window.localStorage.length).toBe(0);
    clearVimaxCandidatePending(f.source.projectId, f.source.episodeId, pending);
    expect(readVimaxCandidatePending(f.source.projectId, f.source.episodeId)).toBeNull();
  });
  it("isolates project/episode and refuses to overwrite an unconfirmed request", () => {
    const f = vimaxCandidateFixture(); const [first, second] = cases();
    writeVimaxCandidatePending(f.source.projectId, f.source.episodeId, first!);
    expect(() => writeVimaxCandidatePending(f.source.projectId, f.source.episodeId, second!)).toThrow("未确认");
    expect(readVimaxCandidatePending("other-project", f.source.episodeId)).toBeNull();
    expect(readVimaxCandidatePending(f.source.projectId, "other-episode")).toBeNull();
    expect(readVimaxCandidatePending(f.source.projectId, f.source.episodeId)).toEqual(first);
  });
  it("a late receipt cannot clear a newer request or changed body under the same key", () => {
    const f = vimaxCandidateFixture(); const [first, second] = cases();
    writeVimaxCandidatePending(f.source.projectId, f.source.episodeId, second!);
    clearVimaxCandidatePending(f.source.projectId, f.source.episodeId, first!);
    expect(readVimaxCandidatePending(f.source.projectId, f.source.episodeId)).toEqual(second);
    const sameKeyDifferentBody = { ...second!, body: { ...second!.body, expectedVersion: 9 } } as VimaxCandidatePending;
    clearVimaxCandidatePending(f.source.projectId, f.source.episodeId, sameKeyDifferentBody);
    expect(readVimaxCandidatePending(f.source.projectId, f.source.episodeId)).toEqual(second);
  });
  it.each(["{private-text", "null", "{}", JSON.stringify({ kind: "create", key: "not-a-uuid", body: {} })])("refuses corrupt persisted state without removing it: %s", (raw) => {
    const f = vimaxCandidateFixture(); const key = keyFor(f.source.projectId, f.source.episodeId);
    window.sessionStorage.setItem(key, raw);
    expect(() => readVimaxCandidatePending(f.source.projectId, f.source.episodeId)).toThrow();
    expect(window.sessionStorage.getItem(key)).toBe(raw);
  });
  it("rejects extra credential fields rather than persisting them", () => {
    const f = vimaxCandidateFixture(); const pending = { ...cases()[0]!, token: "must-not-be-saved" };
    expect(() => writeVimaxCandidatePending(f.source.projectId, f.source.episodeId, pending as VimaxCandidatePending)).toThrow();
    expect(window.sessionStorage.length).toBe(0);
  });
  it("blocks a send when storage is full or the readback is incomplete", () => {
    const f = vimaxCandidateFixture(); const pending = cases()[0]!;
    const set = vi.spyOn(window.sessionStorage, "setItem").mockImplementation(() => { throw new Error("quota"); });
    expect(() => writeVimaxCandidatePending(f.source.projectId, f.source.episodeId, pending)).toThrow("quota");
    set.mockRestore();
    vi.spyOn(window.sessionStorage, "setItem").mockImplementation(() => undefined);
    expect(() => writeVimaxCandidatePending(f.source.projectId, f.source.episodeId, pending)).toThrow("尚未发送");
  });
});
