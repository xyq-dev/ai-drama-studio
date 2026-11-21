import { expect, it } from "vitest";
import { AdminOpsStore } from "./admin-ops-store";

const WORKSPACE = "11111111-1111-4111-8111-111111111111";
const JOB = "00000000-0000-4000-8000-000000002169";

it("compares job ids as uuid in detail and cursor queries", async () => {
  const queries: string[] = [];
  const client = {
    async query(sql: string) {
      queries.push(sql);
      if (sql.includes("to_regclass") || sql.includes("information_schema")) {
        return {
          rows: [{
            owner: false, episodes: false, creators: false, scripts: false, assets: false,
            jobs: true, shots: false, autoRuns: true, titleRuns: false, seriesRuns: false,
          }],
        };
      }
      return { rows: [] };
    },
    release() {},
  };
  const store = new AdminOpsStore({ connect: async () => client } as never);
  await store.getJob(WORKSPACE, JOB);
  const cursor = Buffer.from(JSON.stringify({
    v: 1, at: "2026-11-21T10:16:41.000Z", id: JOB,
  }), "utf8").toString("base64url");
  await store.listJobs(WORKSPACE, { cursor, limit: 20 });
  const detail = queries.find((sql) => sql.includes("WHERE id = $2::uuid"));
  const page = queries.find((sql) => sql.includes("::uuid)"));
  expect(detail).toBeTruthy();
  expect(detail).not.toContain("SELECT id::text AS id");
  expect(page).toContain("::uuid)");
  expect(page).not.toContain("SELECT id::text AS id");
});
