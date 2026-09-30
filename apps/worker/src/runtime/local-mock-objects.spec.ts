import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalMockObjects } from "./local-mock-objects";

const io = vi.hoisted(() => ({
  failFileSync: false,
  directorySyncCode: null as string | null,
  failRename: false,
  failDirectoryOpen: false,
  renameCalls: 0,
  handles: [] as Array<{ flags: string; closed: boolean }>,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    async open(path: Parameters<typeof actual.open>[0], flags?: Parameters<typeof actual.open>[1]) {
      if (io.failDirectoryOpen && flags === "r") {
        throw Object.assign(new Error("directory open failed"), { code: "EIO" });
      }
      const handle = await actual.open(path, flags);
      const record = { flags: String(flags), closed: false };
      io.handles.push(record);
      const sync = handle.sync.bind(handle);
      const close = handle.close.bind(handle);
      handle.sync = async () => {
        if (flags !== "r" && io.failFileSync) {
          throw Object.assign(new Error("file sync failed"), { code: "EPERM" });
        }
        if (flags === "r" && io.directorySyncCode) {
          throw Object.assign(new Error("directory sync failed"), { code: io.directorySyncCode });
        }
        return sync();
      };
      handle.close = async () => {
        record.closed = true;
        return close();
      };
      return handle;
    },
    async rename(from: Parameters<typeof actual.rename>[0], to: Parameters<typeof actual.rename>[1]) {
      if (io.failRename) throw Object.assign(new Error("rename failed"), { code: "EIO" });
      io.renameCalls += 1;
      return actual.rename(from, to);
    },
  };
});

const originalPlatform = process.platform;

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
}

function resetIo(): void {
  io.failFileSync = false;
  io.directorySyncCode = null;
  io.failRename = false;
  io.failDirectoryOpen = false;
  io.renameCalls = 0;
  io.handles = [];
  setPlatform(originalPlatform);
}

async function temporaryNames(root: string): Promise<string[]> {
  const pending: string[] = [root];
  const names: string[] = [];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) continue;
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.name.includes(".tmp")) names.push(path);
    }
  }
  return names;
}

function fixture() {
  const bytes = Buffer.from("fixture");
  const checksumSha256 = createHash("sha256").update(bytes).digest("hex");
  const key = `mock-images/11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222/${checksumSha256}.png`;
  return { bytes, checksumSha256, key, input: { key, bytes, mimeType: "image/png" as const, checksumSha256 } };
}

afterEach(() => {
  resetIo();
});

describe("real filesystem", () => {
  it("retries a deterministic object write without changing bytes", async () => {
    const root = await mkdtemp(join(tmpdir(), "m3-mock-"));
    try {
      const { bytes, input } = fixture();
      const store = new LocalMockObjects(root);
      await store.put(input);
      await store.put(input);
      expect(await readFile(join(root, input.key))).toEqual(bytes);
      await expect(store.put({ ...input, bytes: Buffer.from("different") })).rejects.toThrow(/checksum mismatch/i);
      await expect(store.put({ ...input, key: "../escape.png" })).rejects.toThrow(/Invalid Mock object key/i);
      expect(await temporaryNames(root)).toEqual([]);
      expect(io.handles.every((handle) => handle.closed)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("injected I/O", () => {
  it("rejects file sync EPERM before rename and removes the temporary file", async () => {
    const root = await mkdtemp(join(tmpdir(), "m3-mock-file-sync-"));
    io.failFileSync = true;
    try {
      const store = new LocalMockObjects(root);
      await expect(store.put(fixture().input)).rejects.toThrow(/file sync failed/i);
      expect(io.renameCalls).toBe(0);
      expect(await temporaryNames(root)).toEqual([]);
      expect(io.handles).toHaveLength(1);
      expect(io.handles.every((handle) => handle.closed)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a non-EPERM directory sync error on Windows", async () => {
    const root = await mkdtemp(join(tmpdir(), "m3-mock-dir-eio-"));
    io.directorySyncCode = "EIO";
    try {
      await expect(new LocalMockObjects(root).put(fixture().input)).rejects.toThrow(/directory sync failed/i);
      expect(io.renameCalls).toBe(1);
      expect(await temporaryNames(root)).toEqual([]);
      expect(io.handles.every((handle) => handle.closed)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects directory sync EPERM when the platform is not Windows", async () => {
    const root = await mkdtemp(join(tmpdir(), "m3-mock-dir-platform-"));
    setPlatform("linux");
    io.directorySyncCode = "EPERM";
    try {
      await expect(new LocalMockObjects(root).put(fixture().input)).rejects.toMatchObject({ code: "EPERM" });
      expect(await temporaryNames(root)).toEqual([]);
      expect(io.handles.every((handle) => handle.closed)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("propagates directory open and rename failures", async () => {
    const renameRoot = await mkdtemp(join(tmpdir(), "m3-mock-rename-"));
    io.failRename = true;
    try {
      await expect(new LocalMockObjects(renameRoot).put(fixture().input)).rejects.toThrow(/rename failed/i);
      expect(await temporaryNames(renameRoot)).toEqual([]);
      expect(io.handles.every((handle) => handle.closed)).toBe(true);
    } finally {
      await rm(renameRoot, { recursive: true, force: true });
    }
    resetIo();
    const openRoot = await mkdtemp(join(tmpdir(), "m3-mock-open-"));
    io.failDirectoryOpen = true;
    try {
      await expect(new LocalMockObjects(openRoot).put(fixture().input)).rejects.toThrow(/directory open failed/i);
      expect(await temporaryNames(openRoot)).toEqual([]);
      expect(io.handles.every((handle) => handle.closed)).toBe(true);
    } finally {
      await rm(openRoot, { recursive: true, force: true });
    }
  });
});
