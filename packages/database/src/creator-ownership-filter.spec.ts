import type { PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";
import { runWithStoreCreatorAccess } from "./creator-access-context";
import { MediaAssetStore } from "./media-assets";
import { RuntimeStore } from "./runtime-store";

const WORKSPACE = "11111111-1111-4111-8111-111111111111";
const OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const JOB = "22222222-2222-4222-8222-222222222222";
const ASSET = "33333333-3333-4333-8333-333333333333";
const RUN = "44444444-4444-4444-8444-444444444444";

type Statement = { sql: string; values: unknown[] };
type Answer = { rows: Array<Record<string, unknown>> };
const EMPTY: Answer = { rows: [] };

function harness(answers: Answer[] = []) {
  const statements: Statement[] = [];
  const release = vi.fn();
  const query = async (sql: string, values: unknown[] = []): Promise<Answer> => {
    statements.push({ sql, values });
    const answer = answers.shift();
    if (!answer) throw new Error(`Unexpected query: ${sql}`);
    return answer;
  };
  const client = { query, release } as unknown as PoolClient;
  const pool = { connect: async () => client };
  return {
    runtime: new RuntimeStore(pool),
    assets: new MediaAssetStore(pool),
    statements,
    release,
  };
}

describe("creator ownership filters on non-project resources", () => {
  it("scopes getJob through project.owner_account_id when ALS is set", async () => {
    const { runtime, statements } = harness([
      { rows: [{ present: true }] },
      EMPTY,
    ]);
    await expect(runWithStoreCreatorAccess(
      { kind: "scoped", ownerAccountId: OWNER, actorId: `creator:${OWNER}` },
      () => runtime.getJob(WORKSPACE, JOB),
    )).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(statements.at(-1)?.sql).toContain("p.owner_account_id = $3::uuid");
    expect(statements.at(-1)?.values).toEqual([JOB, WORKSPACE, OWNER]);
  });

  it("scopes getWorkflow through project.owner_account_id when ALS is set", async () => {
    const { runtime, statements } = harness([
      { rows: [{ present: true }] },
      EMPTY,
    ]);
    await expect(runWithStoreCreatorAccess(
      { kind: "scoped", ownerAccountId: OWNER, actorId: `creator:${OWNER}` },
      () => runtime.getWorkflow(WORKSPACE, RUN),
    )).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(statements.at(-1)?.sql).toContain("p.owner_account_id = $3::uuid");
    expect(statements.at(-1)?.values).toEqual([RUN, WORKSPACE, OWNER]);
  });

  it("scopes getWorkspaceAsset through project.owner_account_id when ALS is set", async () => {
    const { assets, statements } = harness([
      { rows: [{ present: true }] },
      EMPTY,
    ]);
    await expect(runWithStoreCreatorAccess(
      { kind: "scoped", ownerAccountId: OWNER, actorId: `creator:${OWNER}` },
      () => assets.getWorkspaceAsset(WORKSPACE, ASSET),
    )).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(statements.at(-1)?.sql).toContain("p.owner_account_id = $3::uuid");
    expect(statements.at(-1)?.values).toEqual([ASSET, WORKSPACE, OWNER]);
  });

  it("scopes listEventsAfter to the creator's projects and drops workspace-global rows", async () => {
    const { runtime, statements } = harness([
      { rows: [{ present: true }] },
      EMPTY,
    ]);
    await expect(runWithStoreCreatorAccess(
      { kind: "scoped", ownerAccountId: OWNER, actorId: `creator:${OWNER}` },
      () => runtime.listEventsAfter(WORKSPACE, "0", 10),
    )).resolves.toEqual([]);
    const list = statements.at(-1);
    expect(list?.sql).toContain("e.project_id IS NOT NULL");
    expect(list?.sql).toContain("p.owner_account_id = $4::uuid");
    expect(list?.values).toEqual([WORKSPACE, "0", 10, OWNER]);
  });

  it("leaves jobs and assets open when ALS is open (auth disabled)", async () => {
    const { runtime, assets, statements } = harness([
      EMPTY,
      EMPTY,
    ]);
    await expect(runWithStoreCreatorAccess({ kind: "open" }, () => runtime.getJob(WORKSPACE, JOB)))
      .rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(runWithStoreCreatorAccess({ kind: "open" }, () => assets.getWorkspaceAsset(WORKSPACE, ASSET)))
      .rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(statements.every((statement) => !statement.sql.includes("owner_account_id"))).toBe(true);
    expect(statements[0]?.values).toEqual([JOB, WORKSPACE]);
    expect(statements[1]?.values).toEqual([ASSET, WORKSPACE]);
  });

  it("does not let a second creator id leak into another scope's binds", async () => {
    const first = harness([{ rows: [{ present: true }] }, EMPTY]);
    await expect(runWithStoreCreatorAccess(
      { kind: "scoped", ownerAccountId: OWNER, actorId: `creator:${OWNER}` },
      () => first.runtime.getJob(WORKSPACE, JOB),
    )).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(first.statements.at(-1)?.values).toEqual([JOB, WORKSPACE, OWNER]);

    const second = harness([{ rows: [{ present: true }] }, EMPTY]);
    await expect(runWithStoreCreatorAccess(
      { kind: "scoped", ownerAccountId: OTHER, actorId: `creator:${OTHER}` },
      () => second.runtime.getJob(WORKSPACE, JOB),
    )).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(second.statements.at(-1)?.values).toEqual([JOB, WORKSPACE, OTHER]);
  });
});
