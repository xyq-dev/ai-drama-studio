import { mkdtemp, readFile, rm, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { OperationLogStore, noteCredentialChange, setOperationJournal } from "./operation-log-store";

const dirs: string[] = [];

afterEach(async () => {
  setOperationJournal(null);
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function open(): Promise<OperationLogStore> {
  const dir = await mkdtemp(join(tmpdir(), "ads-oplog-"));
  dirs.push(dir);
  await chmod(dir, 0o700);
  return new OperationLogStore(join(dir, "operation-log.json"));
}

it("stores only a mask for a saved credential and rejects plaintext", async () => {
  const store = await open();
  setOperationJournal(store);
  const secret = "sk-synthetic-8hd";
  await noteCredentialChange({
    action: "保存媒体密钥",
    label: "MiniMax",
    status: "已保存",
    secret,
    source: "管理后台 /admin/media-keys",
  });
  const [record] = await store.list();
  expect(record?.secretStatus).toBe("已保存");
  expect(record?.secretMask).toBe("sk-***8hd");
  expect(record?.target).toContain("已保存");
  expect(JSON.stringify(record)).not.toContain(secret);
  const raw = await readFile(join(dirs[0]!, "operation-log.json"), "utf8");
  expect(raw).not.toContain(secret);
  expect(raw).not.toMatch(/password/i);
  await expect(store.append({
    action: "保存媒体密钥",
    target: `MiniMax ${secret}`,
    result: "success",
    source: "管理后台 /admin/media-keys",
  }, [secret])).rejects.toThrow(/OPERATION_LOG_SECRET/);
});
