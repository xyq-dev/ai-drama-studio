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
        // Mirror the store: keep only __adsUserRevise when present; otherwise clear.
        if (sql.includes("__adsUserRevise")) {
          const meta = stage.depends_on_json as { __adsUserRevise?: string } | null;
          stage.depends_on_json = meta && typeof meta.__adsUserRevise === "string"
            ? { __adsUserRevise: meta.__adsUserRevise } : null;
        } else if (sql.includes("depends_on_json = NULL")) {
          stage.depends_on_json = null;
        }
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

  it("keeps __adsUserRevise on prepareResume and syncs companions before completing the revise stage", async () => {
    const now = "2026-11-18T00:00:00.000Z";
    const brief = JSON.stringify({
      pathVersion: "ads.auto-creation.user-revise.v1", findingIds: [], instruction: "改动机",
      episodeTargets: [1], syncStory: true,
    });
    const run = { id: "run", workspace_id: "ws", project_id: "project", executor_id: "executor", state: "needs_attention",
      story_save: "saved", call_cap: 12, calls_used: 8, updated_at: now, created_at: now };
    const stage = { run_id: run.id, stage_key: "revise:1:episode:1", ordinal: 8, attempt_no: 1, state: "unknown", error_code: "timeout",
      updated_at: now, output_json: null, output_hash: null, depends_on_json: { __adsUserRevise: brief } as unknown };
    const companionWrites: string[] = [];
    const query = vi.fn(async (sql: string, args?: unknown[]) => {
      if (sql.startsWith("SELECT run_id, stage_key FROM auto_creation_call")) return { rows: [{ run_id: run.id, stage_key: "revise:1:episode:1" }] };
      if (sql.startsWith("SELECT executor_id FROM auto_creation_run")) return { rows: [run] };
      if (sql.includes("FROM auto_creation_run WHERE id = $1 AND workspace_id = $2 AND project_id = $3")) return { rows: [run] };
      if (sql.includes("FROM auto_creation_run WHERE id = $1")) return { rows: [run] };
      if (sql.startsWith("SELECT 1 FROM auto_creation_stage WHERE run_id = $1 AND stage_key = $2 AND state = 'completed'")) {
        return { rowCount: 1, rows: [{ "?column?": 1 }] };
      }
      if (sql.startsWith("UPDATE auto_creation_stage SET output_json = $3::jsonb")) {
        companionWrites.push(String(args?.[1]));
        return { rowCount: 1, rows: [] };
      }
      if (sql.startsWith("UPDATE auto_creation_stage SET state = $3")) {
        expect(companionWrites).toEqual(["bible", "outline"]);
        stage.state = String(args?.[2]);
        stage.depends_on_json = args?.[6] == null ? null : JSON.parse(String(args[6]));
        return { rowCount: 1, rows: [] };
      }
      if (sql.startsWith("UPDATE auto_creation_stage SET state = 'pending'")) {
        stage.state = "pending";
        if (sql.includes("__adsUserRevise")) {
          const meta = stage.depends_on_json as { __adsUserRevise?: string } | null;
          stage.depends_on_json = meta && typeof meta.__adsUserRevise === "string"
            ? { __adsUserRevise: meta.__adsUserRevise } : null;
        }
        return { rowCount: 1, rows: [] };
      }
      if (sql.startsWith("UPDATE auto_creation_run SET state = 'running'")) return { rows: [{ ...run, state: "running" }] };
      if (sql.includes("FROM auto_creation_stage WHERE run_id = $1")) return { rows: [stage] };
      if (sql.includes("FROM auto_creation_call WHERE run_id = $1")) return { rows: [] };
      if (sql.includes("FROM auto_creation_resume")) return { rows: [] };
      return { rows: [], rowCount: 1 };
    });
    const pool = { connect: async () => ({ query, release: () => undefined }) as unknown as PoolClient };
    const store = new PostgresAutoCreationStore(pool, new TextChainService(pool));

    const resumed = await store.prepareResume("ws", "project", "run", {
      resumeKey: "resume-user-brief", requestHash: "hash", confirmedCallIds: [], maxActiveRuns: 1, providerReady: true, blocked: false,
    }, now);
    expect(resumed.kind).toBe("ok");
    expect(stage.depends_on_json).toEqual({ __adsUserRevise: brief });

    companionWrites.length = 0;
    expect(await store.finishCall("ws", "call", "executor", {
      state: "completed", errorCode: null, output: { schema: "ads.auto-creation.episode.v1" } as never, outputHash: "h",
      dependsOn: {}, providerRequestId: null, responseModel: null,
      usage: { status: "unknown", inputTokens: null, outputTokens: null, totalTokens: null },
      companionStages: [
        { stageKey: "bible", output: { schema: "ads.auto-creation.bible.v1" } as never, outputHash: "b" },
        { stageKey: "outline", output: { schema: "ads.auto-creation.outline.v1" } as never, outputHash: "o" },
      ],
    }, now)).toBe(true);
    expect(companionWrites).toEqual(["bible", "outline"]);
    expect(stage.state).toBe("completed");
  });
});
