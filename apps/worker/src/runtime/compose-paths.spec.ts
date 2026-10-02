import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { containedFile, createRenewalQueue, publishContainedBytes, stageEpisodeSources } from "./compose-job";

const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "compose-path-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("compose path boundaries", () => {
  it("rejects an intermediate directory symlink before reading outside bytes", async () => {
    const root = await tempRoot();
    const outside = await tempRoot();
    await writeFile(join(outside, "secret.txt"), "secret");
    await symlink(outside, join(root, "jump"), process.platform === "win32" ? "junction" : "dir");
    await expect(containedFile(root, "jump/secret.txt", 6)).rejects.toThrow(/escapes/);
    expect(await readFile(join(outside, "secret.txt"), "utf8")).toBe("secret");
  });

  it("publishes hashed bytes atomically and does not replace an existing object when publish fails", async () => {
    const root = await tempRoot();
    await publishContainedBytes(root, "compose/project/job/attempt/abc.mp4", Buffer.from("first"));
    await expect(publishContainedBytes(root, "compose/project/job/attempt/abc.mp4", Buffer.from("second"))).rejects.toThrow(/already exists/);
    expect(await readFile(join(root, "compose/project/job/attempt/abc.mp4"), "utf8")).toBe("first");
    await writeFile(join(root, "blocked"), "keep");
    await expect(publishContainedBytes(root, "blocked/out.mp4", Buffer.from("new"))).rejects.toThrow();
    expect(await readFile(join(root, "blocked"), "utf8")).toBe("keep");
  });

  it("stages episode sources one file at a time and rejects a bad hash, size, or link", async () => {
    const root = await tempRoot();
    const attempt = await tempRoot();
    const workspaceId = "11111111-1111-4111-8111-111111111111";
    const projectId = "22222222-2222-4222-8222-222222222222";
    const first = Buffer.alloc(80_000, 3);
    const second = Buffer.alloc(40_000, 9);
    const firstHash = createHash("sha256").update(first).digest("hex");
    const secondHash = createHash("sha256").update(second).digest("hex");
    const key = (hash: string) => `compose/${workspaceId}/${projectId}/77777777-7777-4777-8777-777777777777/88888888-8888-4888-8888-888888888888/${hash}.mp4`;
    await mkdir(join(root, `compose/${workspaceId}/${projectId}/77777777-7777-4777-8777-777777777777/88888888-8888-4888-8888-888888888888`), { recursive: true });
    await writeFile(join(root, key(firstHash)), first);
    await writeFile(join(root, key(secondHash)), second);
    const source = (assetId: string, hash: string, bytes: Buffer) => ({
      assetId, shotId: "55555555-5555-4555-8555-555555555555", shotRevisionId: "66666666-6666-4666-8666-666666666666",
      storageProvider: "local-compose", objectKey: key(hash), byteSize: bytes.length, checksumSha256: hash,
      durationMs: 1000, startMs: 0, endMs: 1000,
    });
    const execution = {
      workspaceId, projectId, episodeId: "33333333-3333-4333-8333-333333333333",
      jobId: "99999999-9999-4999-8999-999999999999", dispatchSeq: 1, inputHash: "ab".repeat(32), traceId: "trace",
      inputSnapshot: { schema: "m4.episode.compose.v1", input: { sourceObjects: [
        source("44444444-4444-4444-8444-444444444441", firstHash, first),
        source("44444444-4444-4444-8444-444444444442", secondHash, second),
      ] } },
    };
    await stageEpisodeSources(root, attempt, execution as never);
    expect((await readFile(join(attempt, "seg-000.mp4"))).equals(first)).toBe(true);
    expect((await readFile(join(root, key(firstHash)))).equals(first)).toBe(true);
    const plan = JSON.parse(await readFile(join(attempt, "plan.json"), "utf8")) as { durationMs: number[]; totalDurationMs: number };
    expect(plan.durationMs).toEqual([1000, 1000]);
    expect(plan.totalDurationMs).toBe(2000);
    const bad = { ...execution, inputSnapshot: { schema: execution.inputSnapshot.schema, input: { sourceObjects: [
      { ...source("44444444-4444-4444-8444-444444444441", firstHash, first), checksumSha256: "cd".repeat(32) },
      source("44444444-4444-4444-8444-444444444442", secondHash, second),
    ] } } };
    await expect(stageEpisodeSources(root, await tempRoot(), bad as never)).rejects.toThrow(/checksum/);
    const outside = await tempRoot();
    await symlink(outside, join(root, "jump"), process.platform === "win32" ? "junction" : "dir");
    const linked = { ...execution, inputSnapshot: { schema: execution.inputSnapshot.schema, input: { sourceObjects: [
      { ...source("44444444-4444-4444-8444-444444444441", firstHash, first), objectKey: "jump/secret.mp4", byteSize: 6 },
      source("44444444-4444-4444-8444-444444444442", secondHash, second),
    ] } } };
    await expect(stageEpisodeSources(root, await tempRoot(), linked as never)).rejects.toThrow(/outside|escapes|regular/i);
  });

  it("runs lease renewal one at a time and stops the child when renewal fails", async () => {
    let active = 0;
    let maxActive = 0;
    let calls = 0;
    const stops: string[] = [];
    const queue = createRenewalQueue(async () => {
      calls += 1;
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 20));
      active -= 1;
      if (calls === 2) throw new Error("database unavailable");
      return true;
    }, () => stops.push("stopped"));
    queue.push();
    queue.push();
    await queue.idle();
    expect(maxActive).toBe(1);
    expect(stops).toEqual(["stopped"]);
  });
});
