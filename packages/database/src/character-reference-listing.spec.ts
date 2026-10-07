import type { PoolClient } from "pg";
import { describe, expect, it } from "vitest";
import { CHARACTER_REFERENCE_PAGE_SIZE, CharacterReferenceStore } from "./character-reference-store";

/**
 * listForCharacter against a fake client that answers each statement by applying its bound parameters to rows in
 * memory. It checks which reads the store issues and with which scope; the SQL itself runs against PostgreSQL only
 * on the authorized reference draft (character-reference-store.integration.spec.ts).
 */
const WORKSPACE = "11111111-1111-4111-8111-111111111111";
const OTHER_WORKSPACE = "99999999-9999-4999-8999-999999999999";
const PROJECT = "22222222-2222-4222-8222-222222222222";
const OTHER_PROJECT = "88888888-8888-4888-8888-888888888888";
const CHARACTER = "33333333-3333-4333-8333-333333333333";
const OTHER_CHARACTER = "77777777-7777-4777-8777-777777777777";
const REVISION = "44444444-4444-4444-8444-444444444444";
const OLD_REVISION = "55555555-5555-4555-8555-555555555555";
const HASH = "ab".repeat(32);

interface Row {
  id: string;
  workspace_id: string;
  project_id: string;
  character_id: string;
  source_character_revision_id: string;
  reference_role: string | null;
  status: string;
  review_status: string;
  reviewed_content_hash: string | null;
  checksum_sha256: string;
  created_at: Date;
}

interface World {
  character: { project_id: string; current_revision_id: string | null; approved_revision_id: string | null;
    revision_review: string | null; revision_freshness: string | null };
  selection: { project_id: string; source_character_revision_id: string; asset_id: string } | null;
  assets: Row[];
}

function assetId(index: number): string {
  return `aaaaaaaa-aaaa-4aaa-8aaa-${String(index).padStart(12, "0")}`;
}

function reference(index: number, overrides: Partial<Row> = {}): Row {
  return {
    id: assetId(index), workspace_id: WORKSPACE, project_id: PROJECT, character_id: CHARACTER,
    source_character_revision_id: REVISION, reference_role: "character_reference", status: "ACTIVE",
    review_status: "APPROVED", reviewed_content_hash: HASH, checksum_sha256: HASH,
    created_at: new Date(Date.UTC(2026, 9, 1) + index * 1000), ...overrides,
  };
}

function asRow(row: Row) {
  return { ...row, source_generation_job_id: null, object_key: `refs/${row.id}.png`, mime_type: "image/png", byte_size: 1,
    width: 1, height: 1, review_note: null, row_version: 2 };
}

function harness(world: World) {
  const statements: Array<{ sql: string; values: unknown[] }> = [];
  const query = async (sql: string, values: unknown[] = []) => {
    statements.push({ sql, values });
    if (sql.includes("information_schema.columns")) {
      return { rows: Array.from({ length: 9 }, (_, index) => ({ table_name: "t", column_name: `c${index}` })) };
    }
    if (sql.includes("pg_constraint")) return { rows: [{ definition: "CHECK (reference_role = 'character_reference')" }] };
    if (sql.includes("FROM character\n")) {
      const [characterId, workspaceId] = values;
      return { rows: characterId === CHARACTER && workspaceId === WORKSPACE ? [{ id: CHARACTER, ...world.character }] : [] };
    }
    if (sql.includes("FROM character_reference_selection")) {
      const [workspaceId, projectId, characterId] = values;
      const hit = world.selection && workspaceId === WORKSPACE && characterId === CHARACTER
        && projectId === world.selection.project_id;
      return { rows: hit ? [{ character_id: CHARACTER, selected_by: "owner", created_at: new Date(), ...world.selection }] : [] };
    }
    if (sql.includes("WHERE asset.id = $1")) {
      const [id, workspaceId, projectId, characterId, role] = values;
      return { rows: world.assets.filter((row) => row.id === id && row.workspace_id === workspaceId
        && row.project_id === projectId && row.character_id === characterId && row.reference_role === role).map(asRow) };
    }
    if (sql.includes("ORDER BY asset.created_at DESC")) {
      const [workspaceId, projectId, characterId, role, limit] = values as [string, string, string, string, number];
      return { rows: world.assets
        .filter((row) => row.workspace_id === workspaceId && row.project_id === projectId
          && row.character_id === characterId && row.reference_role === role)
        .sort((left, right) => right.created_at.getTime() - left.created_at.getTime() || right.id.localeCompare(left.id))
        .slice(0, limit).map(asRow) };
    }
    throw new Error(`unexpected statement: ${sql}`);
  };
  const client = { query, release: () => undefined } as unknown as PoolClient;
  return { store: new CharacterReferenceStore({ connect: async () => client }), statements };
}

const approvedCharacter = { project_id: PROJECT, current_revision_id: REVISION, approved_revision_id: REVISION,
  revision_review: "APPROVED", revision_freshness: "CURRENT" };

function manyReferences(count: number, overrides: (index: number) => Partial<Row> = () => ({})): Row[] {
  return Array.from({ length: count }, (_, index) => reference(index, overrides(index)));
}

describe("listForCharacter keeps the page bounded and reads the selection by id (closeout item 1)", () => {
  it("finds a usable selection older than the newest 100 references", async () => {
    // 150 references; index 0 is the oldest, far outside the newest-100 page.
    const { store, statements } = harness({ character: approvedCharacter, assets: manyReferences(150),
      selection: { project_id: PROJECT, source_character_revision_id: REVISION, asset_id: assetId(0) } });
    const listing = await store.listForCharacter(WORKSPACE, CHARACTER);
    expect(listing.items).toHaveLength(CHARACTER_REFERENCE_PAGE_SIZE);
    expect(listing.hasMore).toBe(true);
    expect(listing.items.some((item) => item.id === assetId(0))).toBe(false);
    expect(listing.selection).toMatchObject({ assetId: assetId(0), usable: true, asset: { id: assetId(0), status: "ACTIVE" } });
    expect(listing.videoReadiness).toEqual({ usable: true, blockers: [] });
    const page = statements.find((statement) => statement.sql.includes("ORDER BY asset.created_at DESC"))!;
    expect(page.values).toEqual([WORKSPACE, PROJECT, CHARACTER, "character_reference", CHARACTER_REFERENCE_PAGE_SIZE + 1]);
    const byId = statements.filter((statement) => statement.sql.includes("WHERE asset.id = $1"));
    expect(byId).toHaveLength(1);
    expect(byId[0]!.values).toEqual([assetId(0), WORKSPACE, PROJECT, CHARACTER, "character_reference"]);
    // No statement asks for an unbounded or enlarged list.
    for (const statement of statements) expect(statement.sql).not.toMatch(/LIMIT\s+(1000|ALL)/i);
  });

  it("does not issue the by-id read when the selection is already on the page", async () => {
    const { store, statements } = harness({ character: approvedCharacter, assets: manyReferences(3),
      selection: { project_id: PROJECT, source_character_revision_id: REVISION, asset_id: assetId(2) } });
    const listing = await store.listForCharacter(WORKSPACE, CHARACTER);
    expect(listing.hasMore).toBe(false);
    expect(listing.selection).toMatchObject({ usable: true });
    expect(statements.some((statement) => statement.sql.includes("WHERE asset.id = $1"))).toBe(false);
  });

  it("reports a selected reference outside the page that is no longer usable, with the reason", async () => {
    const { store } = harness({ character: approvedCharacter,
      assets: manyReferences(150, (index) => index === 0 ? { status: "STALE" } : {}),
      selection: { project_id: PROJECT, source_character_revision_id: REVISION, asset_id: assetId(0) } });
    const listing = await store.listForCharacter(WORKSPACE, CHARACTER);
    expect(listing.selection).toMatchObject({ assetId: assetId(0), usable: false, asset: { status: "STALE" } });
    expect(listing.videoReadiness).toEqual({ usable: false, blockers: ["REFERENCE_NOT_ACTIVE"] });
  });

  it.each([
    ["another workspace", { workspace_id: OTHER_WORKSPACE }],
    ["another project", { project_id: OTHER_PROJECT }],
    ["another character", { character_id: OTHER_CHARACTER }],
    ["a plain image", { reference_role: null }],
  ])("does not accept a selected asset that belongs to %s", async (_label, scope) => {
    const assets = manyReferences(150);
    assets[0] = { ...assets[0]!, ...scope };
    const { store } = harness({ character: approvedCharacter, assets,
      selection: { project_id: PROJECT, source_character_revision_id: REVISION, asset_id: assetId(0) } });
    const listing = await store.listForCharacter(WORKSPACE, CHARACTER);
    expect(listing.selection).toMatchObject({ assetId: assetId(0), usable: false, asset: null });
    expect(listing.videoReadiness.blockers).toEqual(["REFERENCE_UNAVAILABLE"]);
  });
});

describe("listForCharacter reports the strict video gate's readiness (closeout item 2)", () => {
  it("is not usable for video while the current character revision is unapproved, even with a good reference", async () => {
    const { store } = harness({
      character: { ...approvedCharacter, approved_revision_id: null, revision_review: "DRAFT" },
      assets: manyReferences(2),
      selection: { project_id: PROJECT, source_character_revision_id: REVISION, asset_id: assetId(1) },
    });
    const listing = await store.listForCharacter(WORKSPACE, CHARACTER);
    expect(listing.selection).toMatchObject({ usable: false });
    expect(listing.videoReadiness).toEqual({ usable: false, blockers: ["CHARACTER_REVISION_NOT_APPROVED"] });
    // The reference itself is still selectable: selection does not require an approved character.
    expect(listing.items.every((item) => item.selectable)).toBe(true);
  });

  it("names every reason and keeps history visible", async () => {
    const { store } = harness({
      character: { ...approvedCharacter, revision_freshness: "STALE" },
      assets: [reference(0, { source_character_revision_id: OLD_REVISION, review_status: "REJECTED" }), reference(1)],
      selection: { project_id: PROJECT, source_character_revision_id: OLD_REVISION, asset_id: assetId(0) },
    });
    const listing = await store.listForCharacter(WORKSPACE, CHARACTER);
    expect(listing.videoReadiness.blockers).toEqual(["CHARACTER_REVISION_STALE", "REFERENCE_SELECTION_OTHER_REVISION",
      "REFERENCE_NOT_APPROVED", "REFERENCE_OTHER_REVISION"]);
    expect(listing.items.map((item) => [item.id, item.reviewStatus, item.selectable])).toEqual([
      [assetId(1), "APPROVED", false], [assetId(0), "REJECTED", false]]);
  });

  it("says nothing is selected without reading any asset by id", async () => {
    const { store, statements } = harness({ character: approvedCharacter, assets: manyReferences(1), selection: null });
    const listing = await store.listForCharacter(WORKSPACE, CHARACTER);
    expect(listing.selection).toBeNull();
    expect(listing.videoReadiness).toEqual({ usable: false, blockers: ["REFERENCE_NOT_SELECTED"] });
    expect(statements.some((statement) => statement.sql.includes("WHERE asset.id = $1"))).toBe(false);
  });
});
