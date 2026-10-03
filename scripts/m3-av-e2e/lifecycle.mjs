import { createRequire } from "node:module";
import { resolve } from "node:path";

const MEDIA = [
  { label: "IMAGE", kind: "MEDIA_IMAGE", path: "generate-image", capability: "image.generate" },
  { label: "VIDEO", kind: "MEDIA_VIDEO", path: "generate-video", capability: "video.generate" },
  { label: "AUDIO", kind: "MEDIA_TTS", path: "generate-tts", capability: "audio.tts" },
  { label: "SUBTITLE", kind: "MEDIA_SUBTITLE", path: "generate-subtitle", capability: "subtitle.generate" },
  { label: "MUSIC", kind: "MEDIA_MUSIC", path: "generate-music", capability: "audio.music" },
];

export function blockerList(value) {
  if (Array.isArray(value)) return value.map((item) => String(item));
  if (typeof value === "string") return value.replace(/[{}]/g, "").split(",").map((item) => item.trim()).filter(Boolean);
  return [];
}

export function assertLockOverlap(rows, holderPid, minimum = 1) {
  const holder = String(holderPid);
  const list = Array.isArray(rows) ? rows : [];
  const byPid = new Map(list.map((row) => [String(row.pid), row]));
  const reachesHolder = (pid, seen = new Set()) => {
    if (pid === holder) return true;
    if (seen.has(pid)) return false;
    seen.add(pid);
    const row = byPid.get(pid);
    if (!row) return false;
    return blockerList(row.blockers).some((blocker) => reachesHolder(blocker, seen));
  };
  const matched = list.filter((row) => reachesHolder(String(row.pid)));
  const pids = new Set(matched.map((row) => String(row.pid)));
  if (pids.size < minimum) {
    throw new Error(`pg_blocking_pids did not show ${minimum} waiter(s) blocked by ${holder}`);
  }
  return matched.map((row) => ({
    pid: Number(row.pid),
    blockers: blockerList(row.blockers).map((pid) => Number(pid)),
    waitEventType: row.wait_event_type ?? row.waitEventType ?? null,
    waitEvent: row.wait_event ?? row.waitEvent ?? null,
    query: row.query ?? null,
  }));
}

export function assertCanceledError(errorJson) {
  if (!errorJson || errorJson.code !== "CANCELED") {
    throw new Error(`cancel error_json ${JSON.stringify(errorJson ?? null)}`);
  }
  return {
    code: "CANCELED",
    retryable: Object.hasOwn(errorJson, "retryable") ? errorJson.retryable : null,
  };
}

export function assertTerminalSnapshot(snapshot, expected) {
  const problems = [];
  if (snapshot?.jobState !== expected.jobState) problems.push("job state");
  if (snapshot?.workflowStatus !== expected.workflowStatus) problems.push("workflow");
  if (!snapshot?.finishedAt) problems.push("finished_at");
  if (expected.attemptId && snapshot.attemptId !== expected.attemptId) problems.push("attempt");
  if (expected.requestId && snapshot.requestId !== expected.requestId) problems.push("request");
  if (expected.errorCode !== undefined) {
    const actual = snapshot?.errorJson?.code ?? null;
    if (actual !== expected.errorCode) problems.push("error_json");
  }
  if (expected.responseSnapshot !== undefined) {
    if (JSON.stringify(snapshot?.responseSnapshot ?? null) !== JSON.stringify(expected.responseSnapshot)) {
      problems.push("response_snapshot");
    }
  }
  if (expected.assetIds && JSON.stringify(snapshot?.assetIds ?? []) !== JSON.stringify(expected.assetIds)) {
    problems.push("asset ids");
  }
  if (expected.costIds && JSON.stringify(snapshot?.costIds ?? []) !== JSON.stringify(expected.costIds)) {
    problems.push("cost ids");
  }
  if (expected.succeededEvents !== undefined && snapshot?.succeededEvents !== expected.succeededEvents) {
    problems.push("job.succeeded");
  }
  if (expected.canceledEvents !== undefined && snapshot?.canceledEvents !== expected.canceledEvents) {
    problems.push("job.canceled");
  }
  if (expected.cancelRequestedEvents !== undefined && snapshot?.cancelRequestedEvents !== expected.cancelRequestedEvents) {
    problems.push("job.cancel_requested");
  }
  if (problems.length > 0) throw new Error(`terminal snapshot: ${problems.join(", ")}`);
  return snapshot;
}

function iso(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  return String(value);
}

function publicError(value) {
  if (!value || typeof value !== "object") return null;
  return {
    code: value.code ?? null,
    retryable: Object.hasOwn(value, "retryable") ? value.retryable : null,
    message: typeof value.message === "string" ? value.message.slice(0, 200) : null,
  };
}

function eventCount(rows, type) {
  return rows.find((row) => row.event_type === type)?.count ?? 0;
}

async function readTerminal(ctx, jobId) {
  const jobs = await ctx.sql(
    `SELECT id, kind, state, error_code, error_message, source_shot_revision_id, workflow_run_id, cancel_requested_at
       FROM generation_job WHERE id = $1`,
    [jobId],
  );
  const job = jobs[0];
  if (!job) throw new Error(`job ${jobId} missing`);
  const attempts = await ctx.sql(
    `SELECT id, attempt_no, provider_configuration_id, provider_request_id, finished_at, error_json, response_snapshot
       FROM job_attempt WHERE generation_job_id = $1 ORDER BY attempt_no`,
    [jobId],
  );
  const assets = await ctx.sql(
    `SELECT id, source_shot_revision_id, source_generation_job_id, source_job_attempt_id,
            provider_request_id, provider_configuration_id, object_key
       FROM asset WHERE source_generation_job_id = $1 ORDER BY id`,
    [jobId],
  );
  const costs = await ctx.sql(
    `SELECT id, kind, currency, amount_decimal::text AS amount_decimal, job_attempt_id,
            provider_request_id, provider_configuration_id, idempotency_key, supersedes_estimate_key
       FROM cost_ledger WHERE generation_job_id = $1 ORDER BY id`,
    [jobId],
  );
  const events = await ctx.sql(
    `SELECT event_type, count(*)::int AS count
       FROM domain_event
      WHERE aggregate_type = 'GenerationJob' AND aggregate_id = $1
        AND event_type IN ('job.succeeded', 'job.failed', 'job.canceled', 'job.cancel_requested')
      GROUP BY event_type`,
    [jobId],
  );
  const workflows = await ctx.sql(
    "SELECT id, status FROM workflow_run WHERE id = $1",
    [job.workflow_run_id],
  );
  const attempt = attempts[0] ?? null;
  return {
    jobId: job.id,
    kind: job.kind,
    jobState: job.state,
    jobErrorCode: job.error_code,
    sourceShotRevisionId: job.source_shot_revision_id,
    workflowRunId: job.workflow_run_id,
    workflowStatus: workflows[0]?.status ?? null,
    cancelRequestedAt: iso(job.cancel_requested_at),
    attemptId: attempt?.id ?? null,
    attemptNo: attempt?.attempt_no ?? null,
    attemptCount: attempts.length,
    requestId: attempt?.provider_request_id ?? null,
    providerConfigurationId: attempt?.provider_configuration_id ?? null,
    finishedAt: iso(attempt?.finished_at),
    errorJson: publicError(attempt?.error_json),
    responseSnapshot: attempt?.response_snapshot ?? null,
    assetIds: assets.map((asset) => asset.id),
    assets,
    costIds: costs.map((cost) => cost.id),
    costs,
    succeededEvents: eventCount(events, "job.succeeded"),
    failedEvents: eventCount(events, "job.failed"),
    canceledEvents: eventCount(events, "job.canceled"),
    cancelRequestedEvents: eventCount(events, "job.cancel_requested"),
  };
}

function fingerprint(snapshot) {
  return JSON.stringify({
    jobState: snapshot.jobState,
    jobErrorCode: snapshot.jobErrorCode,
    workflowStatus: snapshot.workflowStatus,
    attemptId: snapshot.attemptId,
    attemptCount: snapshot.attemptCount,
    requestId: snapshot.requestId,
    finishedAt: snapshot.finishedAt,
    errorJson: snapshot.errorJson,
    responseSnapshot: snapshot.responseSnapshot,
    assetIds: snapshot.assetIds,
    costIds: snapshot.costIds,
    succeededEvents: snapshot.succeededEvents,
    failedEvents: snapshot.failedEvents,
    canceledEvents: snapshot.canceledEvents,
    cancelRequestedEvents: snapshot.cancelRequestedEvents,
  });
}

async function providerEvents(ctx, requestId) {
  return ctx.sql(
    `SELECT id::text AS id, normalized_event_key, external_status, source
       FROM provider_event WHERE provider_request_id = $1 ORDER BY id`,
    [requestId],
  );
}

async function bindRunning(ctx, revisionId, spec, seed) {
  const accepted = ctx.expectStatus(await ctx.callApi(
    ctx.apiOrigin, "POST", `/shot-revisions/${revisionId}/${spec.path}`,
    { body: { seed } },
  ), 202);
  const attached = await ctx.waitAttachedRequest(accepted.body.jobId);
  return {
    spec,
    jobId: accepted.body.jobId,
    workflowRunId: accepted.body.workflowRunId,
    attemptId: attached.attempts[0].id,
    requestId: attached.attempts[0].provider_request_id,
    providerConfigurationId: attached.attempts[0].provider_configuration_id,
  };
}

async function controlWorker(ctx, fn) {
  let resumed = false;
  const resume = async () => {
    if (resumed) return;
    resumed = true;
    await ctx.restoreMockDir();
    await ctx.startWorker();
  };
  try {
    await ctx.stopApp("worker");
    return await fn(resume);
  } finally {
    await ctx.restoreMockDir();
    if (!resumed) await resume();
  }
}

function loadBuilt(ctx) {
  const require = createRequire(resolve(ctx.repo, "apps/worker/package.json"));
  const database = require("@ai-drama/database");
  const { MockMediaAdapter } = require("@ai-drama/providers");
  const pool = database.createPostgresPool({
    connectionString: ctx.databaseUrl,
    connectionTimeoutMs: 5_000,
    statementTimeoutMs: 20_000,
    queryTimeoutMs: 20_000,
  });
  return {
    database,
    MockMediaAdapter,
    pool,
    jobs: new database.JobPersistenceService(pool),
    assets: new database.MediaAssetStore(pool),
    objects: new (require(resolve(ctx.repo, "apps/worker/dist/runtime/local-mock-objects.js")).LocalMockObjects)(ctx.mockDir),
    recoverImage: require(resolve(ctx.repo, "apps/worker/dist/runtime/mock-image-generation.js")).recoverMockImageAttempt,
    recoverAv: require(resolve(ctx.repo, "apps/worker/dist/runtime/mock-av-generation.js")).recoverMockAvAttempt,
    recoverSm: require(resolve(ctx.repo, "apps/worker/dist/runtime/mock-sm-generation.js")).recoverMockSmAttempt,
  };
}

function watchAdapter(Adapter) {
  const adapter = new Adapter();
  const calls = { submit: 0, inspect: 0, measuredOn: "harness-imported-adapter-instance" };
  const submit = adapter.submit.bind(adapter);
  const inspect = adapter.inspect.bind(adapter);
  adapter.submit = async (...args) => {
    calls.submit += 1;
    return submit(...args);
  };
  adapter.inspect = async (...args) => {
    calls.inspect += 1;
    return inspect(...args);
  };
  return { adapter, calls };
}

function recoverCall(built, adapter, snapshot, traceId) {
  const input = {
    workspaceId: snapshot.workspaceId,
    projectId: snapshot.projectId,
    shotRevisionId: snapshot.sourceShotRevisionId,
    jobId: snapshot.jobId,
    providerConfigurationId: snapshot.providerConfigurationId,
    traceId,
    attemptId: snapshot.attemptId,
    providerRequestId: snapshot.requestId,
    inputSnapshot: snapshot.inputSnapshot,
  };
  const dependencies = { jobs: built.jobs, assets: built.assets, adapter, objects: built.objects };
  if (snapshot.kind === "MEDIA_IMAGE") return built.recoverImage(input, dependencies);
  if (snapshot.kind === "MEDIA_SUBTITLE" || snapshot.kind === "MEDIA_MUSIC") {
    return built.recoverSm({
      ...input,
      capability: snapshot.kind === "MEDIA_SUBTITLE" ? "subtitle.generate" : "audio.music",
    }, dependencies);
  }
  return built.recoverAv({
    ...input,
    capability: snapshot.kind === "MEDIA_VIDEO" ? "video.generate" : "audio.tts",
  }, dependencies);
}

async function readInput(ctx, jobId) {
  const rows = await ctx.sql(
    "SELECT kind, input_snapshot, source_shot_revision_id FROM generation_job WHERE id = $1",
    [jobId],
  );
  return rows[0];
}

async function expectTerminalRace(run) {
  try {
    const value = await run();
    const id = value && typeof value === "object" && "id" in value ? value.id : null;
    throw new Error(`recovery reopened a terminal job ${id ?? JSON.stringify(value)}`);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("recovery reopened")) throw error;
    if (error?.code !== "JOB_TERMINAL") throw error;
    return "JOB_TERMINAL";
  }
}

async function blockingRows(ctx, holderPid) {
  return ctx.sql(
    `SELECT pid, pg_blocking_pids(pid) AS blockers, wait_event_type, wait_event, left(query, 180) AS query
       FROM pg_stat_activity
      WHERE datname = current_database()
        AND cardinality(pg_blocking_pids(pid)) > 0`,
  );
}

async function waitBlocked(ctx, holderPid, minimum, deadline) {
  let last = [];
  while (Date.now() < deadline) {
    last = await blockingRows(ctx, holderPid);
    try {
      return assertLockOverlap(last, holderPid, minimum);
    } catch {
      await ctx.sleep(100);
    }
  }
  throw new Error(`pg_blocking_pids overlap missing for ${holderPid}: ${JSON.stringify(last)}`);
}

async function holdJobLock(ctx, jobId, work) {
  const require = createRequire(resolve(ctx.repo, "packages/database/package.json"));
  const { Client } = require("pg");
  const client = new Client({ connectionString: ctx.databaseUrl });
  client.on("error", () => undefined);
  await client.connect();
  let open = false;
  try {
    await client.query("SET statement_timeout = 0");
    await client.query("BEGIN");
    open = true;
    const holderPid = Number((await client.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);
    await client.query("SELECT id FROM generation_job WHERE id = $1 FOR UPDATE", [jobId]);
    return await work({
      holderPid,
      release: async () => {
        if (!open) return;
        await client.query("ROLLBACK");
        open = false;
      },
    });
  } finally {
    if (open) {
      try { await client.query("ROLLBACK"); } catch { /* lock already released */ }
    }
    try { await client.end(); } catch { /* connection already closed */ }
  }
}

function assertNoSuccess(snapshot) {
  assertTerminalSnapshot(snapshot, {
    jobState: "CANCELED",
    workflowStatus: "CANCELED",
    attemptId: snapshot.attemptId,
    errorCode: "CANCELED",
    responseSnapshot: null,
    assetIds: [],
    costIds: [],
    succeededEvents: 0,
    canceledEvents: 1,
    cancelRequestedEvents: 1,
  });
  assertCanceledError(snapshot.errorJson);
  if (snapshot.costs.length !== 0 || snapshot.assets.length !== 0) {
    throw new Error("canceled job kept an asset or cost");
  }
}

function assertOneActual(snapshot) {
  if (snapshot.costs.length !== 1 || snapshot.assets.length !== 1) {
    throw new Error(`expected one asset and one cost, got ${snapshot.assets.length}/${snapshot.costs.length}`);
  }
  const cost = snapshot.costs[0];
  if (cost.kind !== "ACTUAL" || cost.currency !== "USD" || Number(cost.amount_decimal) !== 0 || cost.supersedes_estimate_key !== null) {
    throw new Error(`actual cost mismatch ${JSON.stringify(cost)}`);
  }
  if (snapshot.succeededEvents !== 1) throw new Error(`succeeded events ${snapshot.succeededEvents}`);
  assertTerminalSnapshot(snapshot, {
    jobState: "SUCCEEDED",
    workflowStatus: "SUCCEEDED",
    attemptId: snapshot.attemptId,
    requestId: snapshot.requestId,
    errorCode: null,
    assetIds: snapshot.assetIds,
    costIds: snapshot.costIds,
    succeededEvents: 1,
  });
}

export async function mediaCancel(ctx) {
  const prepared = [];
  await ctx.breakMockDir();
  try {
    for (const spec of MEDIA) {
      prepared.push(await bindRunning(ctx, ctx.state.world.shotRevisionId, spec, `lifecycle-cancel-${spec.label.toLowerCase()}`));
    }
    return await controlWorker(ctx, async (resume) => {
      const results = [];
      for (const item of prepared) {
        const key = `lifecycle-cancel-${item.jobId}`;
        const before = await readTerminal(ctx, item.jobId);
        if (before.attemptId !== item.attemptId || before.requestId !== item.requestId || before.attemptCount !== 1) {
          throw new Error(`cancel bind changed ${item.label}`);
        }
        const first = ctx.expectStatus(await ctx.callApi(
          ctx.apiOrigin, "POST", `/generation-jobs/${item.jobId}/cancel`,
          { key, body: {} },
        ), 200);
        const requested = await readTerminal(ctx, item.jobId);
        if (!requested.cancelRequestedAt || requested.cancelRequestedEvents !== 1 || requested.canceledEvents !== 0) {
          throw new Error(`cancel request was not recorded once ${JSON.stringify(requested)}`);
        }
        if (requested.attemptId !== item.attemptId || requested.attemptCount !== 1 || requested.finishedAt) {
          throw new Error(`cancel request changed the attempt ${item.label}`);
        }
        const replay = ctx.expectStatus(await ctx.callApi(
          ctx.apiOrigin, "POST", `/generation-jobs/${item.jobId}/cancel`,
          { key, body: {} },
        ), 200);
        if (JSON.stringify(replay.body) !== JSON.stringify(first.body)) {
          throw new Error(`cancel replay body changed ${item.label}`);
        }
        const afterReplay = await readTerminal(ctx, item.jobId);
        if (fingerprint(afterReplay) !== fingerprint(requested)) {
          throw new Error(`cancel replay wrote a new row ${item.label}`);
        }
        results.push({ item, key, first: first.body, requested });
      }
      await resume();
      const settled = [];
      for (const result of results) {
        const done = await ctx.pollJob(result.item.jobId, 130_000);
        const workflow = ctx.expectStatus(await ctx.callApi(
          ctx.apiOrigin, "GET", `/workflow-runs/${result.item.workflowRunId}`,
        ), 200);
        const finalSnapshot = await readTerminal(ctx, result.item.jobId);
        if (done.state !== "CANCELED" || workflow.body.status !== "CANCELED") {
          throw new Error(`cancel final ${result.item.spec.label} ${done.state} ${workflow.body.status}`);
        }
        if (finalSnapshot.attemptId !== result.item.attemptId || finalSnapshot.requestId !== result.item.requestId) {
          throw new Error(`cancel recovery replaced the attempt ${result.item.spec.label}`);
        }
        assertNoSuccess(finalSnapshot);
        const replay = ctx.expectStatus(await ctx.callApi(
          ctx.apiOrigin, "POST", `/generation-jobs/${result.item.jobId}/cancel`,
          { key: result.key, body: {} },
        ), 200);
        if (JSON.stringify(replay.body) !== JSON.stringify(result.first)) {
          throw new Error(`stored cancel response changed after recovery ${result.item.spec.label}`);
        }
        const afterStoredReplay = await readTerminal(ctx, result.item.jobId);
        if (fingerprint(afterStoredReplay) !== fingerprint(finalSnapshot)) {
          throw new Error(`stored cancel replay added a write ${result.item.spec.label}`);
        }
        settled.push({
          channel: "http-and-worker-process",
          label: result.item.spec.label,
          kind: result.item.spec.kind,
          jobId: result.item.jobId,
          workflowRunId: result.item.workflowRunId,
          attemptId: finalSnapshot.attemptId,
          requestId: finalSnapshot.requestId,
          finishedAt: finalSnapshot.finishedAt,
          errorJson: finalSnapshot.errorJson,
          responseSnapshot: finalSnapshot.responseSnapshot,
          workflowStatus: workflow.body.status,
          assetIds: finalSnapshot.assetIds,
          costIds: finalSnapshot.costIds,
          succeededEvents: finalSnapshot.succeededEvents,
          canceledEvents: finalSnapshot.canceledEvents,
          cancelRequestedEvents: finalSnapshot.cancelRequestedEvents,
          storedReplayMatched: true,
        });
      }
      ctx.state.lifecycleCanceled = settled;
      return { results: settled };
    });
  } finally {
    await ctx.restoreMockDir();
  }
}

async function raceOne(ctx, built, spec, order) {
  await ctx.breakMockDir();
  try {
  const bound = await bindRunning(ctx, ctx.state.world.shotRevisionId, spec, `lifecycle-race-${spec.label.toLowerCase()}-${order}`);
  const input = await readInput(ctx, bound.jobId);
  return await controlWorker(ctx, async () => {
    await ctx.restoreMockDir();
    const adapter = new built.MockMediaAdapter();
    const completionInput = {
      workspaceId: ctx.workspaceId,
      projectId: ctx.state.world.projectId,
      sourceShotRevisionId: input.source_shot_revision_id,
      jobId: bound.jobId,
      providerConfigurationId: bound.providerConfigurationId,
      attemptId: bound.attemptId,
      requestId: bound.requestId,
      inputSnapshot: input.input_snapshot,
      kind: spec.kind,
    };
    const evidence = await holdJobLock(ctx, bound.jobId, async ({ holderPid, release }) => {
      const pending = [];
      let released = false;
      const safeRelease = async () => {
        if (released) return;
        released = true;
        await release();
      };
      const startCancel = () => ctx.callApi(ctx.apiOrigin, "POST", `/generation-jobs/${bound.jobId}/cancel`, {
        key: `lifecycle-race-cancel-${order}-${bound.jobId}`,
        body: {},
      });
      const startSuccess = () => recoverCall(
        built, adapter, completionInput, `m3-lifecycle:race:${order}:${bound.jobId}`,
      );
      try {
        const first = order === "cancel-first" ? startCancel() : startSuccess();
        pending.push(first);
        const firstBlocked = await waitBlocked(ctx, holderPid, 1, Date.now() + 8_000);
        const second = order === "cancel-first" ? startSuccess() : startCancel();
        pending.push(second);
        const bothBlocked = await waitBlocked(ctx, holderPid, 2, Date.now() + 5_000);
        await safeRelease();
        const [firstResult, secondResult] = await Promise.allSettled(pending);
        return {
          holderPid,
          firstBlocked,
          bothBlocked,
          cancel: order === "cancel-first" ? firstResult : secondResult,
          success: order === "cancel-first" ? secondResult : firstResult,
        };
      } catch (error) {
        await safeRelease();
        await Promise.allSettled(pending);
        throw error;
      }
    });
    const finalSnapshot = await readTerminal(ctx, bound.jobId);
    const workflow = ctx.expectStatus(await ctx.callApi(
      ctx.apiOrigin, "GET", `/workflow-runs/${bound.workflowRunId}`,
    ), 200);
    if (order === "cancel-first") {
      if (evidence.success.status !== "fulfilled" || evidence.success.value !== null) {
        throw new Error(`cancel-first completion did not honor cancel ${spec.label} ${describeSettled(evidence.success)}`);
      }
      if (evidence.cancel.status !== "fulfilled" || evidence.cancel.value.status !== 200) {
        throw new Error(`cancel-first HTTP ${describeSettled(evidence.cancel)}`);
      }
      if (finalSnapshot.jobState !== "CANCELED" || workflow.body.status !== "CANCELED") {
        throw new Error(`cancel-first terminal ${finalSnapshot.jobState} ${workflow.body.status}`);
      }
      assertNoSuccess(finalSnapshot);
    } else {
      if (evidence.success.status !== "fulfilled" || !evidence.success.value?.id) {
        throw new Error(`success-first completion failed ${spec.label} ${describeSettled(evidence.success)}`);
      }
      if (evidence.cancel.status !== "fulfilled" || evidence.cancel.value.status !== 409 || evidence.cancel.value.body?.error?.code !== "JOB_TERMINAL") {
        throw new Error(`success-first cancel ${describeSettled(evidence.cancel)}`);
      }
      assertOneActual(finalSnapshot);
      if (workflow.body.status !== "SUCCEEDED") throw new Error(`success-first workflow ${workflow.body.status}`);
      const beforeLate = fingerprint(finalSnapshot);
      const late = await ctx.callApi(ctx.apiOrigin, "POST", `/generation-jobs/${bound.jobId}/cancel`, {
        key: `lifecycle-race-late-${bound.jobId}`,
        body: {},
      });
      if (late.status !== 409 || late.body?.error?.code !== "JOB_TERMINAL") {
        throw new Error(`late cancel ${late.status} ${JSON.stringify(late.body)}`);
      }
      const afterLate = await readTerminal(ctx, bound.jobId);
      if (fingerprint(afterLate) !== beforeLate) throw new Error(`late cancel changed the success record ${spec.label}`);
    }
    return {
      channel: {
        cancel: "http",
        completion: "internal-worker-function",
        lock: "acceptance-connection",
        workerProcess: "stopped",
      },
      order,
      label: spec.label,
      kind: spec.kind,
      jobId: bound.jobId,
      workflowRunId: bound.workflowRunId,
      attemptId: finalSnapshot.attemptId,
      requestId: finalSnapshot.requestId,
      holderPid: evidence.holderPid,
      firstBlocked: evidence.firstBlocked,
      bothBlocked: evidence.bothBlocked,
      jobState: finalSnapshot.jobState,
      workflowStatus: finalSnapshot.workflowStatus,
      finishedAt: finalSnapshot.finishedAt,
      errorJson: finalSnapshot.errorJson,
      responseSnapshot: finalSnapshot.responseSnapshot,
      assetIds: finalSnapshot.assetIds,
      costIds: finalSnapshot.costIds,
      succeededEvents: finalSnapshot.succeededEvents,
      canceledEvents: finalSnapshot.canceledEvents,
    };
  });
  } finally {
    await ctx.restoreMockDir();
  }
}

function describeSettled(result) {
  if (!result) return "missing";
  if (result.status === "rejected") {
    const reason = result.reason;
    return reason instanceof Error ? reason.message : String(reason);
  }
  const value = result.value;
  if (value && typeof value === "object" && "status" in value) {
    return `${value.status} ${JSON.stringify(value.body)}`;
  }
  if (value && typeof value === "object" && "id" in value) return `asset ${value.id}`;
  return JSON.stringify(value);
}

export async function mediaTerminalRace(ctx) {
  const built = loadBuilt(ctx);
  try {
    const results = [];
    for (const spec of MEDIA.filter((item) => item.label === "IMAGE" || item.label === "VIDEO")) {
      for (const order of ["cancel-first", "success-first"]) {
        results.push(await raceOne(ctx, built, spec, order));
      }
    }
    ctx.state.lifecycleRace = results;
    return { results };
  } finally {
    await built.pool.end();
  }
}

async function replayBound(ctx, built, watched, jobId, label, options) {
  const row = await readInput(ctx, jobId);
  const before = await readTerminal(ctx, jobId);
  before.inputSnapshot = row.input_snapshot;
  before.workspaceId = ctx.workspaceId;
  before.projectId = ctx.state.world.projectId;
  const eventsBefore = await providerEvents(ctx, before.requestId);
  const inspectBefore = watched.calls.inspect;
  const submitBefore = watched.calls.submit;
  const firstCode = await expectTerminalRace(() => recoverCall(
    built, watched.adapter, before, `m3-lifecycle:observe:1:${jobId}`,
  ));
  const mid = await readTerminal(ctx, jobId);
  const eventsMid = await providerEvents(ctx, before.requestId);
  const inserted = eventsMid.filter((event) => !eventsBefore.some((prior) => prior.id === event.id));
  if (options.expectInsert) {
    if (eventsBefore.length !== 0 || inserted.length !== 1) {
      throw new Error(`${label} first observation did not audit one new event`);
    }
  } else if (inserted.length !== 0) {
    throw new Error(`${label} repeated the same observation as a new event`);
  }
  if (inserted.length === 1) {
    if (!inserted[0].normalized_event_key.startsWith("poll:") || inserted[0].external_status !== "SUCCEEDED" || inserted[0].source !== "POLL") {
      throw new Error(`${label} audited event ${JSON.stringify(inserted[0])}`);
    }
  }
  const key = (inserted[0] ?? eventsMid[0])?.normalized_event_key ?? null;
  if (!key) throw new Error(`${label} has no provider event key`);
  const secondCode = await expectTerminalRace(() => recoverCall(
    built, watched.adapter, before, `m3-lifecycle:observe:2:${jobId}`,
  ));
  const after = await readTerminal(ctx, jobId);
  const eventsAfter = await providerEvents(ctx, before.requestId);
  if (fingerprint(after) !== fingerprint(before) || fingerprint(mid) !== fingerprint(before)) {
    throw new Error(`${label} terminal state changed during observation replay`);
  }
  if (eventsAfter.length !== eventsMid.length) throw new Error(`${label} duplicated a provider event`);
  const sameKey = eventsAfter.filter((event) => event.normalized_event_key === key);
  if (sameKey.length !== 1) throw new Error(`${label} normalizedEventKey ${key} occurred ${sameKey.length} times`);
  if (watched.calls.submit !== submitBefore) throw new Error(`${label} resubmitted on the internal adapter`);
  if (watched.calls.inspect !== inspectBefore + 2) throw new Error(`${label} did not inspect twice`);
  return {
    channel: "internal-service-on-postgres",
    label,
    kind: before.kind,
    jobId,
    attemptId: after.attemptId,
    requestId: after.requestId,
    jobState: after.jobState,
    workflowStatus: after.workflowStatus,
    finishedAt: after.finishedAt,
    errorJson: after.errorJson,
    responseSnapshot: after.responseSnapshot,
    assetIds: after.assetIds,
    costIds: after.costIds,
    succeededEvents: after.succeededEvents,
    normalizedEventKey: key,
    providerEventIds: eventsAfter.map((event) => event.id),
    externalStatus: sameKey[0].external_status,
    firstObservation: firstCode,
    secondObservation: secondCode,
    insertedEventId: inserted[0]?.id ?? null,
    deduped: true,
    internalAdapterSubmitCalls: watched.calls.submit,
    internalAdapterInspectCalls: watched.calls.inspect,
    adapterCallScope: watched.calls.measuredOn,
  };
}

export async function mediaObservationReplay(ctx) {
  const imagePost = ctx.state.posts.find((post) => post.url.includes("generate-image") && post.status === 202 && post.body?.jobId);
  const canceled = (ctx.state.lifecycleCanceled ?? []).find((item) => item.label === "IMAGE");
  if (!imagePost || !ctx.state.world.video || !ctx.state.world.speech || !ctx.state.world.subtitle || !ctx.state.world.music || !canceled) {
    throw new Error("observation replay is missing a real bound success or canceled job");
  }
  const failedShot = await ctx.createApprovedShot(5, "lifecycle-failed", ctx.promptText, ctx.dialogueText);
  await ctx.breakMockDir();
  let failedJobId = null;
  let workerDown = false;
  try {
    const failedBound = await bindRunning(ctx, failedShot.revisionId, MEDIA[1], "lifecycle-failed-video");
    failedJobId = failedBound.jobId;
    await ctx.stopApp("worker");
    workerDown = true;
    const aggregate = ctx.expectStatus(await ctx.callApi(
      ctx.apiOrigin, "GET",
      `/projects/${ctx.state.world.projectId}/episodes/${ctx.state.world.episodeId}/scenes/${ctx.state.world.sceneId}/shots/${failedShot.shotId}/revisions`,
    ), 200).body.aggregate;
    const created = ctx.expectStatus(await ctx.callApi(
      ctx.apiOrigin, "POST",
      `/projects/${ctx.state.world.projectId}/episodes/${ctx.state.world.episodeId}/scenes/${ctx.state.world.sceneId}/shots/${failedShot.shotId}/revisions`,
      {
        ifMatch: aggregate.rowVersion,
        body: ctx.shotPayload(ctx.state.world.sceneRevisionId, 5, "lifecycle-source-changed", ctx.promptText, ctx.dialogueText),
      },
    ), 201);
    await ctx.approve(
      ctx.apiOrigin,
      `/projects/${ctx.state.world.projectId}/episodes/${ctx.state.world.episodeId}/scenes/${ctx.state.world.sceneId}/shots/${failedShot.shotId}/revisions/${created.body.revisionId}/review`,
      created.body.rowVersion,
    );
    await ctx.restoreMockDir();
    workerDown = false;
    await ctx.startWorker();
    const failed = await ctx.pollJob(failedJobId, 130_000);
    const failedLedger = await ctx.jobLedger(failedJobId);
    if (failed.state !== "FAILED" || failedLedger.job.error_code !== "MOCK_AV_OUTPUT_INVALID") {
      throw new Error(`failed observation source ${failed.state} ${failedLedger.job?.error_code ?? ""}`);
    }
    ctx.assertLinkage(ctx.linkageSnapshot(failedLedger), {
      expectAsset: false,
      expectCost: false,
      errorCode: "MOCK_AV_OUTPUT_INVALID",
    });
  } finally {
    await ctx.restoreMockDir();
    if (workerDown) await ctx.startWorker();
  }

  const built = loadBuilt(ctx);
  try {
    const watched = watchAdapter(built.MockMediaAdapter);
    const successes = [
      ["IMAGE", imagePost.body.jobId],
      ["VIDEO", ctx.state.world.video.jobId],
      ["AUDIO", ctx.state.world.speech.jobId],
      ["SUBTITLE", ctx.state.world.subtitle.jobId],
      ["MUSIC", ctx.state.world.music.jobId],
    ];
    const results = [];
    for (const [label, jobId] of successes) {
      results.push(await replayBound(ctx, built, watched, jobId, label, { expectInsert: true }));
    }
    results.push(await replayBound(ctx, built, watched, canceled.jobId, "CANCELED", { expectInsert: true }));
    results.push(await replayBound(ctx, built, watched, failedJobId, "FAILED", { expectInsert: false }));
    if (watched.calls.submit !== 0) {
      throw new Error(`internal adapter submit count ${watched.calls.submit}`);
    }
    return {
      adapterCallScope: "harness-imported-adapter-instance",
      internalAdapterSubmitCalls: watched.calls.submit,
      internalAdapterInspectCalls: watched.calls.inspect,
      workerProcessSubmitCalls: null,
      results,
    };
  } finally {
    await built.pool.end();
  }
}

function shotUrl(ctx, shotId) {
  return `${ctx.webOrigin}/projects/${ctx.state.world.projectId}?focus=shot&episode=1&scene=${ctx.state.world.sceneId}&shot=${shotId}`;
}

async function browserShows(ctx, shotId, revisionId, forbiddenIds, requiredIds) {
  const page = ctx.state.page;
  const responsePromise = page.waitForResponse((response) =>
    response.url().includes(`/shot-revisions/${revisionId}/assets`) && response.status() === 200,
  { timeout: 30_000 });
  await page.goto(shotUrl(ctx, shotId), { waitUntil: "domcontentloaded", timeout: 30_000 });
  await page.getByRole("heading", { name: "当前版本图片", exact: true }).waitFor({ timeout: 30_000 });
  const assetsResponse = await responsePromise;
  const payload = await assetsResponse.json();
  const listed = Array.isArray(payload.items) ? payload.items.map((item) => item.id) : [];
  await page.evaluate(() => { window.__m3LifecycleFrames = 0; });
  await page.waitForFunction((probe) => {
    const text = document.body.innerText;
    window.__m3LifecycleFrames = (window.__m3LifecycleFrames ?? 0) + 1;
    if (probe.forbiddenIds.some((id) => text.includes(id))) return true;
    if (probe.requiredIds.length > 0) return probe.requiredIds.every((id) => text.includes(id));
    return window.__m3LifecycleFrames > 30 && text.includes("没有图片") && text.includes("没有视频");
  }, { forbiddenIds, requiredIds }, { timeout: 20_000 });
  const text = await page.locator("body").innerText();
  for (const id of forbiddenIds) {
    if (listed.includes(id) || text.includes(id)) throw new Error(`shot ${shotId} showed foreign id ${id}`);
  }
  for (const id of requiredIds) {
    if (!text.includes(id)) throw new Error(`shot ${shotId} hid its own id ${id}`);
  }
  return { url: page.url(), listedAssetIds: listed, forbiddenIds, requiredIds };
}

export async function mediaShotIsolation(ctx) {
  const shotA = await ctx.createApprovedShot(6, "lifecycle-shot-a", ctx.promptText, ctx.dialogueText);
  const shotB = await ctx.createApprovedShot(7, "lifecycle-shot-b", ctx.promptText, ctx.dialogueText);
  const specs = MEDIA.filter((item) => item.label === "IMAGE" || item.label === "VIDEO");
  await ctx.breakMockDir();
  const bound = [];
  try {
    const accepted = await Promise.all(specs.flatMap((spec) => [
      bindRunning(ctx, shotA.revisionId, spec, `isolation-a-${spec.label.toLowerCase()}`),
      bindRunning(ctx, shotB.revisionId, spec, `isolation-b-${spec.label.toLowerCase()}`),
    ]));
    bound.push(...accepted);
    for (const item of bound) {
      const row = await readInput(ctx, item.jobId);
      item.shot = String(row.source_shot_revision_id) === shotA.revisionId ? "A" : "B";
      item.revisionId = row.source_shot_revision_id;
    }
    return await controlWorker(ctx, async (resume) => {
      for (const item of bound.filter((entry) => entry.shot === "A")) {
        ctx.expectStatus(await ctx.callApi(ctx.apiOrigin, "POST", `/generation-jobs/${item.jobId}/cancel`, {
          key: `isolation-cancel-${item.jobId}`,
          body: {},
        }), 200);
      }
      const bBefore = [];
      for (const item of bound.filter((entry) => entry.shot === "B")) {
        bBefore.push(await readTerminal(ctx, item.jobId));
      }
      await resume();
      const results = [];
      for (const item of bound) {
        const done = await ctx.pollJob(item.jobId, 130_000);
        const finalSnapshot = await readTerminal(ctx, item.jobId);
        const workflow = ctx.expectStatus(await ctx.callApi(
          ctx.apiOrigin, "GET", `/workflow-runs/${item.workflowRunId}`,
        ), 200);
        if (item.shot === "A") {
          if (done.state !== "CANCELED" || workflow.body.status !== "CANCELED") {
            throw new Error(`shot A ${item.spec.label} ${done.state}`);
          }
          assertNoSuccess(finalSnapshot);
        } else {
          if (done.state !== "SUCCEEDED" || workflow.body.status !== "SUCCEEDED") {
            throw new Error(`shot B ${item.spec.label} ${done.state}`);
          }
          const prior = bBefore.find((entry) => entry.jobId === item.jobId);
          if (finalSnapshot.attemptId !== prior.attemptId || finalSnapshot.requestId !== prior.requestId) {
            throw new Error(`shot A cancel changed shot B ${item.spec.label}`);
          }
          assertOneActual(finalSnapshot);
          if (String(finalSnapshot.sourceShotRevisionId) !== String(shotB.revisionId)) {
            throw new Error(`shot B asset revision ${finalSnapshot.sourceShotRevisionId}`);
          }
          if (finalSnapshot.assets.some((asset) => String(asset.source_shot_revision_id) !== String(shotB.revisionId)
            || asset.source_generation_job_id !== item.jobId
            || !asset.object_key.includes(item.jobId)
            || asset.provider_request_id !== item.requestId)) {
            throw new Error(`shot B asset linkage ${JSON.stringify(finalSnapshot.assets)}`);
          }
          if (finalSnapshot.costs.some((cost) => cost.job_attempt_id !== item.attemptId || cost.provider_request_id !== item.requestId)) {
            throw new Error(`shot B cost linkage ${JSON.stringify(finalSnapshot.costs)}`);
          }
          const ledger = await ctx.jobLedger(item.jobId);
          if (item.spec.label === "IMAGE") ctx.assertSuccessfulImage(ledger, shotB.revisionId);
          if (item.spec.label === "VIDEO") {
            ctx.assertLedger(ledger, "MEDIA_VIDEO", shotB.revisionId, ctx.promptText, "video/mp4", 1552,
              "6cbb357d0c5429c415430d0596dfc04417b9fa967eeb34e55186b0a3a9f590e3", 1000, 16);
          }
        }
        results.push({
          shot: item.shot,
          label: item.spec.label,
          jobId: item.jobId,
          workflowRunId: item.workflowRunId,
          attemptId: finalSnapshot.attemptId,
          requestId: finalSnapshot.requestId,
          revisionId: finalSnapshot.sourceShotRevisionId,
          jobState: finalSnapshot.jobState,
          workflowStatus: finalSnapshot.workflowStatus,
          assetIds: finalSnapshot.assetIds,
          costIds: finalSnapshot.costIds,
          objectKeys: finalSnapshot.assets.map((asset) => asset.object_key),
        });
      }
      const bImage = results.find((item) => item.shot === "B" && item.label === "IMAGE");
      const bVideo = results.find((item) => item.shot === "B" && item.label === "VIDEO");
      const aPage = await browserShows(ctx, shotA.shotId, shotA.revisionId, [
        bImage.assetIds[0], bVideo.assetIds[0], bImage.jobId, bVideo.jobId, bImage.revisionId, bVideo.revisionId,
      ], []);
      const bPage = await browserShows(ctx, shotB.shotId, shotB.revisionId, [], [
        bImage.assetIds[0], bVideo.assetIds[0], bImage.jobId, bVideo.jobId, shotB.revisionId,
      ]);
      return {
        channel: "http-worker-process-and-browser",
        shotA,
        shotB,
        results,
        browser: { a: aPage, b: bPage },
      };
    });
  } finally {
    await ctx.restoreMockDir();
  }
}
