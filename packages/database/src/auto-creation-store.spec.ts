import type { PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";
import { PostgresAutoCreationStore } from "./auto-creation-store";
import { TextChainService } from "./text-chain";

describe("Postgres automatic creation research refusal", () => {
  it("writes only stage metadata, separates it from dependencies on read, and clears it when resetting the stage", async () => {
    const now = "2026-11-16T00:00:00.000Z";
    const errorCode = "unsourced_number@contentStructure[5].application.pattern:rank+market_statistic+ranking";
    const diagnostic = { excerpt: "计划比较排名第一的作品", truncated: false };
    const usage = { status: "unknown" as const, inputTokens: null, outputTokens: null, totalTokens: null };
    const run = { id: "run", workspace_id: "ws", project_id: "project", executor_id: "executor", state: "failed",
      story_save: "pending", call_cap: 7, calls_used: 1, updated_at: now, created_at: now };
    const stage = { run_id: run.id, stage_key: "research", ordinal: 1, attempt_no: 1, state: "rejected", error_code: errorCode,
      updated_at: now, output_json: null, output_hash: null, depends_on_json: null as unknown };

    const query = vi.fn(async (sql: string, args?: unknown[]) => {
      if (sql.startsWith("SELECT run_id, stage_key FROM auto_creation_call")) return { rows: [stage] };
      if (sql.startsWith("SELECT executor_id FROM auto_creation_run") || sql.includes("FROM auto_creation_run WHERE id = $1")) return { rows: [run] };
      if (sql.startsWith("UPDATE auto_creation_stage SET state = $3")) {
        stage.depends_on_json = JSON.parse(String(args?.[6])) as unknown;
      }
      if (sql.startsWith("UPDATE auto_creation_stage SET state = 'pending'")) {
        stage.state = "pending";
        if (sql.includes("depends_on_json = NULL")) stage.depends_on_json = null;
      }
      if (sql.startsWith("UPDATE auto_creation_run SET state = 'running'")) return { rows: [{ ...run, state: "running" }] };
      if (sql.includes("FROM auto_creation_stage WHERE run_id = $1")) return { rows: [stage] };
      return { rows: [], rowCount: 1 };
    });
    const pool = { connect: async () => ({ query, release: () => undefined }) as unknown as PoolClient };
    const store = new PostgresAutoCreationStore(pool, new TextChainService(pool));

    const stageOf = async () => (await store.getRun("ws", "project", "run"))?.stages[0];
    expect(await stageOf()).not.toHaveProperty("rejectionDiagnostic");
    expect(await store.finishCall("ws", "call", "executor", { state: "rejected", errorCode, output: null, outputHash: null,
      dependsOn: null, providerRequestId: null, responseModel: null, usage, rejectionDiagnostic: diagnostic }, now)).toBe(true);
    const stageWrite = query.mock.calls.find(([sql]) => sql.startsWith("UPDATE auto_creation_stage SET state = $3"));
    expect(stageWrite?.[1]?.slice(4, 7)).toEqual([null, null, JSON.stringify({ autoResearchRejectionDiagnostic: diagnostic })]);
    const callWrite = query.mock.calls.find(([sql]) => sql.startsWith("UPDATE auto_creation_call SET state = $3"));
    expect(callWrite?.[1]).toEqual(["call", "executor", "rejected", errorCode, null, null, JSON.stringify(usage), now]);
    expect(await stageOf()).toMatchObject({ output: null, outputHash: null, dependsOn: null, rejectionDiagnostic: diagnostic });

    const resumed = await store.prepareResume("ws", "project", "run", { resumeKey: "resume-1", requestHash: "resume-hash",
      confirmedCallIds: [], maxActiveRuns: 1, providerReady: true, blocked: false }, now);
    expect(resumed.kind).toBe("ok");
    expect(stage.depends_on_json).toBeNull();
    expect(await stageOf()).toMatchObject({ state: "pending", dependsOn: null });
    expect(await stageOf()).not.toHaveProperty("rejectionDiagnostic");
  });
});
