import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { containedFile, createRenewalQueue, publishContainedBytes } from "./compose-job";

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
