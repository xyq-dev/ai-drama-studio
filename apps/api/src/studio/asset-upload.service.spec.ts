import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { PersistenceError, runWithStoreCreatorAccess, UploadSessionStore } from "@ai-drama/database";
import { AssetUploadService, type UploadObjectClient } from "./asset-upload.service";

const WS = "11111111-1111-4111-8111-111111111111";
const PROJECT = "22222222-2222-4222-8222-222222222222";
const OTHER_OWNER = "33333333-3333-4333-8333-333333333333";
const OWNER = "44444444-4444-4444-8444-444444444444";

function pngBytes(label = "ok"): Buffer {
  // Minimal non-empty payload; checksum is what the store verifies.
  return Buffer.from(`fake-png-${label}`);
}

function sha(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function memoryObjects(): UploadObjectClient & { store: Map<string, { bytes: Buffer; contentType: string }> } {
  const store = new Map<string, { bytes: Buffer; contentType: string }>();
  return {
    store,
    async put(input) {
      if (store.has(input.key)) return "exists";
      store.set(input.key, { bytes: Buffer.from(input.bytes), contentType: input.contentType });
      return "created";
    },
    async get(key) {
      const found = store.get(key);
      if (!found) throw new Error("MEDIA_OBJECT_STORAGE_UNAVAILABLE");
      const bytes = found.bytes;
      return (async function* () { yield bytes; })();
    },
  };
}

type SessionRow = Record<string, unknown>;

function fakePool(options: {
  ownerColumn?: boolean;
  projectOwnerId?: string;
  ready?: boolean;
  crossAccount?: boolean;
}) {
  const sessions = new Map<string, SessionRow>();
  const assets: Array<Record<string, unknown>> = [];
  const events: unknown[] = [];
  let assetInserts = 0;

  const query = vi.fn(async (sql: string, values: unknown[] = []) => {
    if (sql.includes("obj_description")) {
      return { rows: [{ version: options.ready === false ? null : "ads.upload-session.v1" }] };
    }
    if (sql.includes("information_schema.columns") && sql.includes("owner_account_id")) {
      return { rows: [{ present: options.ownerColumn !== false }] };
    }
    if (sql.startsWith("BEGIN") || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [] };
    if (sql.includes("FROM project") && sql.includes("FOR SHARE")) {
      const ownerFilter = sql.includes("owner_account_id");
      if (options.crossAccount && ownerFilter) return { rows: [] };
      if (ownerFilter && options.projectOwnerId && values[2] !== options.projectOwnerId) return { rows: [] };
      return { rows: [{ id: PROJECT }] };
    }
    if (sql.includes("FROM shot_revision")) return { rows: [] };
    if (sql.startsWith("INSERT INTO upload_session")) {
      const row: SessionRow = {
        id: values[0],
        workspace_id: values[1],
        project_id: values[2],
        storage_provider: values[3],
        temporary_storage_key: values[4],
        expected_mime_type: values[5],
        expected_byte_size: values[6],
        expected_content_hash: values[7],
        status: "PENDING",
        expires_at: new Date(String(values[8])),
        created_by: values[9],
        created_at: new Date(String(values[10])),
        completed_at: null,
        completed_asset_id: null,
        source_shot_revision_id: values[11],
      };
      sessions.set(String(values[0]), row);
      return { rows: [row] };
    }
    if (sql.includes("FROM upload_session s") && sql.includes("JOIN project p")) {
      const id = String(values[0]);
      const row = sessions.get(id);
      if (!row) return { rows: [] };
      if (options.crossAccount && sql.includes("owner_account_id")) return { rows: [] };
      if (sql.includes("owner_account_id") && options.projectOwnerId && values[2] !== options.projectOwnerId) {
        return { rows: [] };
      }
      return { rows: [{ ...row }] };
    }
    if (sql.startsWith("UPDATE upload_session") && sql.includes("SET status = 'COMPLETED'")) {
      const id = String(values[0]);
      const row = sessions.get(id);
      if (!row || row.status !== "UPLOADED") return { rows: [] };
      row.status = "COMPLETED";
      row.completed_at = new Date();
      row.completed_asset_id = values[3];
      row.expected_content_hash = row.expected_content_hash ?? values[4];
      return { rows: [{ ...row }] };
    }
    if (sql.startsWith("UPDATE upload_session") && sql.includes("SET status = 'UPLOADED'")) {
      const id = String(values[0]);
      const row = sessions.get(id);
      if (!row || (row.status !== "PENDING" && row.status !== "UPLOADED")) return { rows: [] };
      row.status = "UPLOADED";
      row.temporary_storage_key = values[3];
      row.expected_content_hash = row.expected_content_hash ?? values[4];
      return { rows: [{ ...row }] };
    }
    if (sql.startsWith("UPDATE upload_session") && sql.includes("EXPIRED")) {
      const id = String(values[0]);
      const row = sessions.get(id);
      if (!row) return { rows: [] };
      row.status = "EXPIRED";
      return { rows: [{ ...row }] };
    }
    if (sql.startsWith("INSERT INTO asset")) {
      assetInserts += 1;
      const id = randomUUID();
      assets.push({
        id,
        workspace_id: values[0],
        project_id: values[1],
        storage_provider: values[2],
        object_key: values[3],
        mime_type: values[4],
        byte_size: values[5],
        checksum_sha256: values[6],
        source_kind: "UPLOAD",
        source_shot_revision_id: values[7],
      });
      return { rows: [{ id }] };
    }
    if (sql.includes("FROM asset") && sql.includes("object_key")) {
      const found = assets.find((a) => a.object_key === values[2]);
      return { rows: found ? [found] : [] };
    }
    if (sql.startsWith("INSERT INTO asset_revision_dependency")) return { rows: [] };
    if (sql.startsWith("INSERT INTO domain_event")) {
      events.push(values);
      return { rows: [] };
    }
    throw new Error(`Unexpected SQL: ${sql.slice(0, 120)}`);
  });

  const release = vi.fn();
  return {
    pool: { connect: async () => ({ query, release }) },
    query,
    sessions,
    assets,
    events,
    assetInsertCount: () => assetInserts,
  };
}

describe("AssetUploadService", () => {
  it("creates a session, accepts bytes, and completes to an UPLOAD asset", async () => {
    const bytes = pngBytes("success");
    const hash = sha(bytes);
    const db = fakePool({ projectOwnerId: OWNER });
    const objects = memoryObjects();
    const service = new AssetUploadService({
      workspaceId: WS,
      store: new UploadSessionStore(db.pool as never),
      objects,
    });

    const created = await runWithStoreCreatorAccess({ kind: "scoped", ownerAccountId: OWNER, actorId: "creator" }, () =>
      service.createSession({
        projectId: PROJECT,
        assetType: "IMAGE",
        mimeType: "image/png",
        byteSize: bytes.byteLength,
        contentHash: hash,
      }));
    expect(created.status).toBe(201);
    const session = (created.body as { uploadSession: { id: string }; uploadUrl: string }).uploadSession;
    expect((created.body as { uploadUrl: string }).uploadUrl).toBe(`/api/v1/asset-upload-sessions/${session.id}/object`);

    const put = await runWithStoreCreatorAccess({ kind: "scoped", ownerAccountId: OWNER, actorId: "creator" }, () =>
      service.putObject(session.id, bytes, {
        contentType: "image/png",
        contentSha256: hash,
        contentLength: String(bytes.byteLength),
      }));
    expect(put.status).toBe(200);
    expect(objects.store.size).toBe(1);

    const done = await runWithStoreCreatorAccess({ kind: "scoped", ownerAccountId: OWNER, actorId: "creator" }, () =>
      service.complete(session.id, "trace-1"));
    expect(done.status).toBe(200);
    expect((done.body as { assetId: string }).assetId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(db.assetInsertCount()).toBe(1);
    expect(db.assets[0]?.source_kind).toBe("UPLOAD");
    expect(db.events).toHaveLength(1);

    const replay = await runWithStoreCreatorAccess({ kind: "scoped", ownerAccountId: OWNER, actorId: "creator" }, () =>
      service.complete(session.id, "trace-2"));
    expect(replay.status).toBe(200);
    expect((replay.body as { assetId: string }).assetId).toBe((done.body as { assetId: string }).assetId);
    expect(db.assetInsertCount()).toBe(1);
  });

  it("refuses bad mime, oversize, and hash mismatch without creating an Asset", async () => {
    const bytes = pngBytes("bad");
    const db = fakePool({});
    const objects = memoryObjects();
    const service = new AssetUploadService({
      workspaceId: WS,
      store: new UploadSessionStore(db.pool as never),
      objects,
    });

    const badMime = await service.createSession({
      projectId: PROJECT, assetType: "IMAGE", mimeType: "image/gif", byteSize: 10,
    });
    expect(badMime.status).toBe(400);
    expect((badMime.body as { error: { code: string } }).error.code).toBe("UNSUPPORTED_MEDIA");

    const oversize = await service.createSession({
      projectId: PROJECT, assetType: "IMAGE", mimeType: "image/png", byteSize: 9 * 1024 * 1024,
    });
    expect(oversize.status).toBe(400);
    expect((oversize.body as { error: { code: string } }).error.code).toBe("UPLOAD_LIMIT");

    const created = await service.createSession({
      projectId: PROJECT,
      assetType: "IMAGE",
      mimeType: "image/png",
      byteSize: bytes.byteLength,
      contentHash: sha(bytes),
    });
    const sessionId = (created.body as { uploadSession: { id: string } }).uploadSession.id;
    const wrongHash = await service.putObject(sessionId, bytes, {
      contentType: "image/png",
      contentSha256: "0".repeat(64),
    });
    expect(wrongHash.status).toBe(409);
    expect((wrongHash.body as { error: { code: string } }).error.code).toBe("OBJECT_HASH_MISMATCH");
    expect(db.assetInsertCount()).toBe(0);
    expect(objects.store.size).toBe(0);
  });

  it("makes a cross-account project look like NOT_FOUND", async () => {
    const bytes = pngBytes("xacct");
    const db = fakePool({ ownerColumn: true, projectOwnerId: OWNER, crossAccount: true });
    const service = new AssetUploadService({
      workspaceId: WS,
      store: new UploadSessionStore(db.pool as never),
      objects: memoryObjects(),
    });
    const result = await runWithStoreCreatorAccess(
      { kind: "scoped", ownerAccountId: OTHER_OWNER, actorId: "intruder" },
      () => service.createSession({
        projectId: PROJECT,
        assetType: "IMAGE",
        mimeType: "image/png",
        byteSize: bytes.byteLength,
      }),
    );
    expect(result.status).toBe(404);
    expect((result.body as { error: { code: string; message: string } }).error.code).toBe("NOT_FOUND");
    expect(db.assetInsertCount()).toBe(0);
  });

  it("refuses clearly when object storage is not wired", async () => {
    const db = fakePool({});
    const service = new AssetUploadService({
      workspaceId: WS,
      store: new UploadSessionStore(db.pool as never),
      objects: null,
    });
    const result = await service.createSession({
      projectId: PROJECT, assetType: "IMAGE", mimeType: "image/png", byteSize: 12,
    });
    expect(result.status).toBe(503);
    expect((result.body as { error: { code: string } }).error.code).toBe("UPLOAD_STORAGE_UNAVAILABLE");
  });

  it("surfaces PersistenceError codes from the store", async () => {
    const store = {
      storageReady: async () => true,
      createSession: async () => {
        throw new PersistenceError("UPLOAD_SESSION_EXPIRED", "上传会话已过期，请重新创建。");
      },
    };
    const service = new AssetUploadService({
      workspaceId: WS,
      store: store as never,
      objects: memoryObjects(),
    });
    const result = await service.createSession({
      projectId: PROJECT, assetType: "IMAGE", mimeType: "image/png", byteSize: 4,
    });
    expect(result.status).toBe(409);
    expect((result.body as { error: { message: string } }).error.message).toContain("过期");
  });
});
