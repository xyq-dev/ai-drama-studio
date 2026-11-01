// In-memory guard tests only. No Pool is constructed and no SQL is executed.
import { describe, expect, it, vi } from "vitest";
import { checkVimaxPlanningAcceptanceEnv, verifyVimaxPlanningAcceptanceDatabase, type VimaxPlanningAcceptanceEnv } from "./vimax-planning-acceptance-guard";
const NAME = "ads_title_acceptance_vimax_offline1";
const VALID: VimaxPlanningAcceptanceEnv = { TITLE_WRITING_ACCEPTANCE_AUTHORIZED: "true", TITLE_WRITING_ACCEPTANCE_DATABASE_NAME: NAME,
  TITLE_WRITING_ACCEPTANCE_DATABASE_URL: `postgres://host/${NAME}`, VIMAX_CANDIDATE_ACCEPTANCE_DRAFT_AUTHORIZED: "true", VIMAX_PLANNING_ACCEPTANCE_DRAFT_AUTHORIZED: "true" };
describe("ViMax planning dedicated disposable acceptance admission", () => {
  it("retains the title-prefix URL contract with all three explicit flags", () => {
    expect(checkVimaxPlanningAcceptanceEnv(VALID)).toEqual({ ok: true, url: VALID.TITLE_WRITING_ACCEPTANCE_DATABASE_URL, databaseName: NAME });
  });
  it.each(["TITLE_WRITING_ACCEPTANCE_AUTHORIZED", "VIMAX_CANDIDATE_ACCEPTANCE_DRAFT_AUTHORIZED", "VIMAX_PLANNING_ACCEPTANCE_DRAFT_AUTHORIZED"] as const)("refuses missing or inexact %s before URL admission", (flag) => {
    for (const value of [undefined, "false", "TRUE", " true"]) {
      const result = checkVimaxPlanningAcceptanceEnv({ ...VALID, [flag]: value });
      expect(result.ok).toBe(false); expect("url" in result).toBe(false);
    }
  });
  it.each(["database", "dbname", "DB"])("refuses dedicated URL %s aliases", (parameter) => {
    expect(checkVimaxPlanningAcceptanceEnv({ ...VALID, TITLE_WRITING_ACCEPTANCE_DATABASE_URL: `postgres://host/${NAME}?${parameter}=production` }).ok).toBe(false);
  });
  it("refuses missing dedicated URL, malformed prefix and same business name on any host", () => {
    expect(checkVimaxPlanningAcceptanceEnv({ ...VALID, TITLE_WRITING_ACCEPTANCE_DATABASE_URL: undefined, DATABASE_URL: VALID.TITLE_WRITING_ACCEPTANCE_DATABASE_URL }).ok).toBe(false);
    expect(checkVimaxPlanningAcceptanceEnv({ ...VALID, TITLE_WRITING_ACCEPTANCE_DATABASE_NAME: "production" }).ok).toBe(false);
    expect(checkVimaxPlanningAcceptanceEnv({ ...VALID, DATABASE_URL: `postgres://other/${NAME.replaceAll("_", "%5f")}` }).ok).toBe(false);
    expect(checkVimaxPlanningAcceptanceEnv({ ...VALID, DATABASE_URL: `postgres://other/business?database=${NAME}` }).ok).toBe(false);
  });
  it("uses the all-schema object verifier and refuses wrong actual identity before object reads", async () => {
    const query = vi.fn(async () => ({ rows: [{ name: "production" }] }));
    expect((await verifyVimaxPlanningAcceptanceDatabase({ query }, NAME)).ok).toBe(false); expect(query).toHaveBeenCalledOnce();
    let reads = 0;
    expect((await verifyVimaxPlanningAcceptanceDatabase({ query: async (sql) => {
      reads += 1; if (reads === 1) return { rows: [{ name: NAME }] };
      expect(sql).toContain("pg_catalog.pg_proc"); expect(sql).toContain("pg_catalog.pg_type"); return { rows: [{ relations: "1" }] };
    } }, NAME)).ok).toBe(false);
  });
});
