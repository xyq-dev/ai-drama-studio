import { randomUUID } from "node:crypto";
import { CreatorAccountStore, type DatabasePool } from "@ai-drama/database";
import { hashPassword } from "../src/auth/password-hash";
import { PostgresMembershipStore } from "../src/membership/membership-store";

/** Called only after the browser suite admits its empty acceptance database and creates the workspace. */
export async function createWritingCreator(pool: DatabasePool, workspaceId: string, password: string) {
  const username = `writer-${randomUUID()}`;
  const account = await new CreatorAccountStore(pool).createActive({
    workspaceId, username, passwordHash: await hashPassword(password, { log2N: 15, r: 8, p: 1, saltBytes: 16, keyBytes: 32 }),
  });
  const store = new PostgresMembershipStore(pool);
  const plan = await store.savePlan(workspaceId, {
    code: "browser-writing", name: "编剧浏览器验收", description: "", active: true, unitPriceAmount: null, unitPriceCurrency: null,
    features: [{ feature: "writing", enabled: true, includedUnits: 200 }],
  });
  await store.grant(workspaceId, {
    accountId: account.id, planId: plan.id, startsAt: new Date(), endsAt: new Date(Date.now() + 86_400_000),
    reason: "隔离环境编剧验收", grantedBy: null,
  });
  return { accountId: account.id, username };
}
