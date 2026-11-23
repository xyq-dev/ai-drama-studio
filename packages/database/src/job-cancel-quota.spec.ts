import { describe, expect, it, vi } from "vitest";
import { JobPersistenceService, type DatabasePool } from "./job-service";

describe("canceling a queued real-media job", () => {
  it.each([false, true])("refunds only when the job has never been claimed (has attempt: %s)", async hasAttempt => {
    const job = { id: "job", workspace_id: "workspace", project_id: "project", workflow_run_id: "workflow",
      state: "QUEUED", row_version: 2, input_snapshot: { schema: "real-media.v1" } };
    const query = vi.fn(async (sql: string, _values?: unknown[]) => {
      if (sql.includes("FROM generation_job") && sql.includes("FOR UPDATE")) return { rows: [job] };
      if (sql.includes("FROM workflow_run")) return { rows: [{ id: "workflow", status: "RUNNING" }] };
      if (sql.includes("SELECT state, is_critical")) return { rows: [{ state: "CANCELED", is_critical: true }] };
      if (sql.includes("FROM job_attempt")) return { rows: hasAttempt ? [{ id: "previous-attempt" }] : [] };
      return { rows: [] };
    });
    const service = new JobPersistenceService({ connect: async () => ({ query, release: vi.fn() }) } as unknown as DatabasePool);
    expect(await service.cancelJob({ workspaceId: "workspace", jobId: "job", traceId: "trace" })).toBe("CANCELED");
    const settle = query.mock.calls.filter(([sql]) => sql.startsWith("UPDATE creator_quota_hold"));
    expect(settle).toEqual(hasAttempt ? [] : [[expect.stringContaining("SET status = 'released'"), ["job"]]]);
  });
});
