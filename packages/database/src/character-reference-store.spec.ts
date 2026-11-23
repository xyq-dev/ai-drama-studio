import { describe, expect, it } from "vitest";
import type { PoolClient } from "pg";
import { runWithStoreCreatorAccess } from "./creator-access-context";
import { CharacterReferenceStore, characterReferenceStorageReady } from "./character-reference-store";

type Query = (sql: string) => Promise<{ rows: unknown[] }>;

function client(query: Query) {
  return { query } as unknown as Parameters<typeof characterReferenceStorageReady>[0];
}

const ALL_COLUMNS = Array.from({ length: 9 }, (_, index) => ({ table_name: "t", column_name: `c${index}` }));

describe("characterReferenceStorageReady", () => {
  it("rethrows a failed probe instead of reporting the structure missing", async () => {
    const timeout = Object.assign(new Error("canceling statement due to statement timeout"), { code: "57014" });
    await expect(characterReferenceStorageReady(client(async () => { throw timeout; }))).rejects.toBe(timeout);
    const lost = Object.assign(new Error("Connection terminated unexpectedly"), {});
    await expect(characterReferenceStorageReady(client(async (sql) => {
      if (sql.includes("pg_constraint")) throw lost;
      return { rows: ALL_COLUMNS };
    }))).rejects.toBe(lost);
  });

  it("reports missing only when the queries succeeded and showed the structure absent", async () => {
    expect(await characterReferenceStorageReady(client(async () => ({ rows: [] })))).toBe(false);
    expect(await characterReferenceStorageReady(client(async (sql) => (sql.includes("pg_constraint")
      ? { rows: [{ definition: "CHECK (review_status <> 'APPROVED' OR kind = 'COMPOSITE')" }] }
      : { rows: ALL_COLUMNS })))).toBe(false);
    expect(await characterReferenceStorageReady(client(async (sql) => (sql.includes("pg_constraint")
      ? { rows: [{ definition: "CHECK (... reference_role = 'character_reference' ...)" }] }
      : { rows: ALL_COLUMNS })))).toBe(true);
  });
});

describe("character reference project visibility", () => {
  for (const operation of ["list", "review", "select", "generate"] as const) {
    it(`requires an active, creator-owned project before ${operation}`, async () => {
      const workspaceId = "workspace", projectId = "project", creator = "creator";
      let guardReads = 0;
      const db = {
        query: async (sql: string, params: unknown[]) => {
          if (sql.includes("column_name = 'owner_account_id'")) return { rows: [{ present: true }] };
          if (sql.includes("SELECT table_name, column_name")) return { rows: ALL_COLUMNS };
          if (sql.includes("pg_constraint")) return { rows: [{ definition: "CHECK (reference_role = 'character_reference')" }] };
          if (sql.includes("SELECT project_id FROM") || sql.includes("SELECT project_id, character_id, content_hash")) {
            return { rows: [{ project_id: projectId, character_id: "character", content_hash: "hash" }] };
          }
          expect(sql).toContain("p.archived_at IS NULL");
          expect(sql).toContain("p.status = 'ACTIVE'");
          expect(sql).toContain("p.owner_account_id = $3::uuid");
          expect(params).toEqual([operation === "list" ? "character" : projectId, workspaceId, creator]);
          if (operation !== "list") expect(sql).toContain("FOR UPDATE");
          guardReads++;
          return { rows: [] };
        },
        release: () => undefined,
      } as unknown as PoolClient;
      const store = new CharacterReferenceStore({ connect: async () => db });
      const result = runWithStoreCreatorAccess({ kind: "scoped", ownerAccountId: creator, actorId: creator }, () => {
        switch (operation) {
          case "list": return store.listForCharacter(workspaceId, "character");
          case "generate": return store.prepareGenerationInTransaction(db, workspaceId, "revision");
          case "review": return store.reviewInTransaction(db, {
            workspaceId, assetId: "asset", reviewedBy: creator, traceId: "review", decision: "APPROVED",
            expectedRowVersion: 1, contentHash: "hash", note: null,
          });
          case "select": return store.selectInTransaction(db, {
            workspaceId, characterId: "character", assetId: "asset", expectedSelectedAssetId: null, selectedBy: creator, traceId: "select",
          });
        }
      });
      await expect(result).rejects.toMatchObject({ code: "NOT_FOUND" });
      expect(guardReads).toBe(1);
    });
  }
});
