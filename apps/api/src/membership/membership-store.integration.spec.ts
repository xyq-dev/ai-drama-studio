import { randomUUID } from "node:crypto";
import { closePostgresPool, createPostgresPool, runMigrations, settleCreatorQuotaHold } from "@ai-drama/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresMembershipStore } from "./membership-store";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required for quota integration tests");

const pool = createPostgresPool({
  connectionString: databaseUrl,
  connectionTimeoutMs: 2_000,
  statementTimeoutMs: 10_000,
  queryTimeoutMs: 10_000,
});
const store = new PostgresMembershipStore(pool);
const workspaceId = randomUUID();

beforeAll(async () => {
  if (!await store.ready()) await runMigrations(pool);
  await pool.query("INSERT INTO workspace (id, name) VALUES ($1, '并发额度测试')", [workspaceId]);
});
afterAll(() => closePostgresPool(pool));

async function memberWithWritingQuota(units: number) {
  const accountId = randomUUID();
  await pool.query(
    `INSERT INTO creator_account (id, workspace_id, username, password_hash, status)
     VALUES ($1, $2, $3, 'fixture', 'ACTIVE')`, [accountId, workspaceId, accountId],
  );
  const plan = await store.savePlan(workspaceId, {
    code: accountId, name: "编剧测试", description: "", active: true, unitPriceAmount: null, unitPriceCurrency: null,
    features: [{ feature: "writing", enabled: true, includedUnits: units }],
  });
  await store.grant(workspaceId, {
    accountId, planId: plan.id, startsAt: new Date(Date.now() - 60_000), endsAt: new Date(Date.now() + 60_000),
    reason: "并发测试", grantedBy: null,
  });
  return accountId;
}

async function settleUnsent(taskKey: string) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await settleCreatorQuotaHold(client, taskKey, "unsent");
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

describe("PostgreSQL membership reservations", () => {
  it.each([1, 3])("charges one of %i units once for concurrent replays", async (units) => {
    const accountId = await memberWithWritingQuota(units);
    const results = await Promise.all(Array.from({ length: 8 }, () => store.reserve(workspaceId, {
      accountId, feature: "writing", idempotencyKey: "same-submission",
    })));
    const holds = results.flatMap((result) => result.ok && "holdId" in result ? [result] : []);
    expect(holds).toHaveLength(results.length);
    expect(new Set(holds.map((hold) => hold.holdId)).size).toBe(1);
    expect(holds.filter((hold) => !hold.replay)).toHaveLength(1);
    expect((await store.balances(workspaceId, accountId)).writing).toBe(units - 1);
    expect((await store.ledger(workspaceId, accountId)).filter((row) => row.kind === "debit")).toHaveLength(1);
  });

  it("charges exactly one of several competing tasks for the last unit", async () => {
    const accountId = await memberWithWritingQuota(1);
    const results = await Promise.all(Array.from({ length: 8 }, () => store.reserve(workspaceId, {
      accountId, feature: "writing", idempotencyKey: randomUUID(),
    })));
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok && result.code === "QUOTA_EXHAUSTED")).toHaveLength(7);
    expect((await store.balances(workspaceId, accountId)).writing).toBe(0);
    expect((await store.ledger(workspaceId, accountId)).filter((row) => row.kind === "debit")).toHaveLength(1);
  });

  it.each(["store release", "run receipt"])("records each debit and refund for repeated attempts via %s", async (source) => {
    const accountId = await memberWithWritingQuota(1);
    const taskKeys: string[] = [];
    for (let attempt = 0; attempt < 3; attempt++) {
      const hold = await store.reserve(workspaceId, { accountId, feature: "writing", idempotencyKey: "retry-unsent" });
      if (!hold.ok || !("holdId" in hold)) throw new Error("Expected a writing quota reservation");
      expect(hold.replay).toBe(false);
      const taskKey = randomUUID();
      taskKeys.push(taskKey);
      await store.bindTask(hold.holdId, taskKey);
      const release = () => source === "run receipt" ? settleUnsent(taskKey) : store.release(hold.holdId);
      await Promise.all([release(), release()]);
      expect((await store.balances(workspaceId, accountId)).writing).toBe(1);
    }
    const rows = await store.ledger(workspaceId, accountId);
    expect(rows.filter((row) => row.kind === "debit")).toHaveLength(3);
    const credits = rows.filter((row) => row.kind === "credit");
    expect(credits).toHaveLength(3);
    if (source === "run receipt") expect(new Set(credits.map((credit) => credit.taskKey))).toEqual(new Set(taskKeys));
  });
});
