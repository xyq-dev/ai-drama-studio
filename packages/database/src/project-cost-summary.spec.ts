import { describe, expect, it } from "vitest";
import { PROJECT_COST_SUMMARY_SQL, PROJECT_COST_SUMMARY_TRANSACTION } from "./project-cost-summary";

describe("project cost summary query", () => {
  it("aggregates in the database without widening joins or narrowing the total", () => {
    expect(PROJECT_COST_SUMMARY_SQL).toContain("NOT EXISTS");
    expect(PROJECT_COST_SUMMARY_SQL).toContain("kind = 'ACTUAL' AND supersedes_cost_id IS NOT NULL");
    expect(PROJECT_COST_SUMMARY_TRANSACTION).toBe("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    expect(PROJECT_COST_SUMMARY_SQL).not.toContain("numeric(20,8)");
    expect(PROJECT_COST_SUMMARY_SQL).not.toContain("parseFloat");
    expect(PROJECT_COST_SUMMARY_SQL).not.toContain("DISTINCT");
    expect(PROJECT_COST_SUMMARY_SQL).not.toContain("FOR UPDATE");
    expect(PROJECT_COST_SUMMARY_SQL).toContain("m4.shot.compose.v1");
    expect(PROJECT_COST_SUMMARY_SQL).toContain("m4.episode.compose.v1");
    expect(PROJECT_COST_SUMMARY_SQL).toContain("job_attempt_id IS NULL");
  });
});