import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const scripted: Buffer[] = [];

vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  return {
    ...actual,
    async open() {
      const payload = scripted.shift();
      if (!payload) throw new Error("missing scripted file");
      return {
        async stat() {
          return { isFile: () => true, size: payload.length - 1 };
        },
        async read(buffer: Buffer, offset: number, length: number, position: number) {
          const slice = payload.subarray(position, position + length);
          slice.copy(buffer, offset);
          return { bytesRead: slice.length };
        },
        async close() {
          return undefined;
        },
      };
    },
  };
});

import { readVerifiedCompositeBytes } from "./compose-content";

const created: string[] = [];
const workspaceId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const jobId = "33333333-3333-4333-8333-333333333333";
const attemptId = "44444444-4444-4444-8444-444444444444";
const checksum = "ab".repeat(32);

afterEach(async () => {
  scripted.splice(0);
  await Promise.all(created.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("bounded composite reads", () => {
  it("rejects a file that grows past the size recorded on the open handle", async () => {
    const root = await mkdtemp(join(tmpdir(), "compose-grow-"));
    created.push(root);
    const key = `compose/${workspaceId}/${projectId}/${jobId}/${attemptId}/${checksum}.mp4`;
    await mkdir(join(root, "compose", workspaceId, projectId, jobId, attemptId), { recursive: true });
    await writeFile(join(root, key), Buffer.from("abcd"));
    scripted.push(Buffer.from("abcdX"));
    await expect(readVerifiedCompositeBytes(root, { objectKey: key, checksumSha256: checksum, byteSize: 4 })).rejects.toThrow(/does not match/);
  });
});
