import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseProductionState, type ProductionEpisode, type ProductionGateResult } from "@ai-drama/domain";
import { ProductionStateReadonlyService } from "./production-state-readonly.service";

const PROJECT = "fixture-minimal-v1";
const FIXTURE = resolve(__dirname, "../../../../docs/fixtures/hongguo-production-state.v1.minimal.json");
const roots: string[] = [];

async function root(): Promise<string> {
  const value = await mkdtemp(resolve(tmpdir(), "hongguo-readonly-"));
  roots.push(value);
  return value;
}

async function fixtureRaw(): Promise<string> {
  return readFile(FIXTURE, "utf8");
}

async function put(rootPath: string, projectId: string, raw: string): Promise<string> {
  const file = resolve(rootPath, projectId, "production-state.json");
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, raw, "utf8");
  return file;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((value) => rm(value, { recursive: true, force: true })));
});

describe("production state readonly service", () => {
  it("returns the validated S1 state and readiness without recalculating the gate", async () => {
    const dir = await root();
    await put(dir, PROJECT, await fixtureRaw());
    const service = new ProductionStateReadonlyService(dir);

    const state = await service.getState(PROJECT);
    expect(state.status).toBe(200);
    expect(state.body).toEqual(expect.objectContaining({ schema: "hongguo-production-state.v1", projectId: PROJECT }));

    const readiness = await service.getReadiness(PROJECT, "S1");
    expect(readiness.status).toBe(200);
    expect(readiness.body).toEqual(expect.objectContaining({ allowed: true, episodeId: "S1", blockers: [] }));
  });

  it("returns only script and dialogue blockers for the constructed S2 fixture", async () => {
    const dir = await root();
    const state = parseProductionState(JSON.parse(await fixtureRaw()));
    const s2: ProductionEpisode = {
      episodeId: "S2",
      status: "draft",
      script: {
        currentVersionId: "fixture/S2/script/draft-v0",
        activeLockedVersionId: null,
        versions: [{ versionId: "fixture/S2/script/draft-v0", status: "draft" }],
      },
      dialogueTimeline: {
        currentVersionId: "fixture/S2/dialogue/draft-v0",
        activeLockedVersionId: null,
        versions: [{ versionId: "fixture/S2/dialogue/draft-v0", status: "draft" }],
      },
      storyboard: null,
      shots: [],
      assemblies: [],
      qa: [],
      retakeRequests: [],
    };
    state.episodes.push(s2);
    await put(dir, PROJECT, JSON.stringify(state, null, 2));
    const service = new ProductionStateReadonlyService(dir);

    const result = await service.getReadiness(PROJECT, "S2");
    expect(result.status).toBe(200);
    const body = result.body as ProductionGateResult;
    expect(body.allowed).toBe(false);
    expect(body.blockers.map((item) => item.code)).toEqual([
      "SCRIPT_LOCK_MISSING",
      "DIALOGUE_LOCK_MISSING",
    ]);
  });

  it.each([
    ["invalid-json", "{not-json"],
    ["invalid-schema", JSON.stringify({ schema: "hongguo-production-state.v1" })],
  ])("maps %s state failures to 422", async (projectId, raw) => {
    const dir = await root();
    await put(dir, projectId, raw);
    const result = await new ProductionStateReadonlyService(dir).getState(projectId);
    expect(result.status).toBe(422);
    expect(result.body).toEqual({ error: { code: "PRODUCTION_STATE_INVALID", message: "Production state is invalid." } });
  });

  it("maps semantic pointer failures to 422", async () => {
    const dir = await root();
    const state = parseProductionState(JSON.parse(await fixtureRaw()));
    state.projectId = "invalid-semantic";
    state.bible.activeLockedVersionId = "missing-version";
    await put(dir, "invalid-semantic", JSON.stringify(state));
    const result = await new ProductionStateReadonlyService(dir).getState("invalid-semantic");
    expect(result.status).toBe(422);
  });

  it("returns 404 for missing projects and episodes", async () => {
    const dir = await root();
    const service = new ProductionStateReadonlyService(dir);
    expect((await service.getState("missing-project")).status).toBe(404);

    await put(dir, PROJECT, await fixtureRaw());
    const episode = await service.getReadiness(PROJECT, "S99");
    expect(episode.status).toBe(404);
    expect(episode.body).toEqual({
      error: { code: "PRODUCTION_EPISODE_NOT_FOUND", message: "Production episode was not found." },
    });
  });

  it.each(["../x", "../../etc", "a/b", "%2e%2e", "", ".hidden", "a..b"])(
    "rejects unsafe identifiers before reading outside the root: %j",
    async (projectId) => {
      const dir = await root();
      const result = await new ProductionStateReadonlyService(dir).getState(projectId);
      expect(result.status).toBe(400);
      expect(result.body).toEqual({
        error: { code: "PRODUCTION_STATE_IDENTIFIER_INVALID", message: "Project identifier is invalid." },
      });
    },
  );

  it("rejects unsafe episode identifiers", async () => {
    const dir = await root();
    await put(dir, PROJECT, await fixtureRaw());
    const service = new ProductionStateReadonlyService(dir);
    for (const episodeId of ["../S1", "S1/S2", "%2e%2e", ""]) {
      expect((await service.getReadiness(PROJECT, episodeId)).status).toBe(400);
    }
  });

  it("never modifies the production-state file or creates lock/tmp artifacts", async () => {
    const dir = await root();
    const file = await put(dir, PROJECT, await fixtureRaw());
    const before = await readFile(file, "utf8");
    const beforeJson = parseProductionState(JSON.parse(before));
    const service = new ProductionStateReadonlyService(dir);

    expect((await service.getState(PROJECT)).status).toBe(200);
    expect((await service.getReadiness(PROJECT, "S1")).status).toBe(200);

    const after = await readFile(file, "utf8");
    const afterJson = parseProductionState(JSON.parse(after));
    expect(after).toBe(before);
    expect(sha256(after)).toBe(sha256(before));
    expect(afterJson.approvalLog).toEqual(beforeJson.approvalLog);
    expect(afterJson.modelPolicy.activeLockedVersionId).toBe(beforeJson.modelPolicy.activeLockedVersionId);
    expect((await readdir(resolve(dir, PROJECT))).filter((name) => name.includes(".lock") || name.includes(".tmp-"))).toEqual([]);
  });
});
