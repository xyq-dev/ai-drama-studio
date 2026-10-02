import assert from "node:assert/strict";
import test from "node:test";
import { acceptanceExitCode, acceptanceFailed, requiredStages } from "./outcome.mjs";
import {
  assertCanceledError,
  assertLockOverlap,
  assertTerminalSnapshot,
  blockerList,
} from "./lifecycle.mjs";

test("lifecycle stages are required and ordered after the image guard", () => {
  assert.equal(requiredStages.length, 45);
  assert.deepEqual(requiredStages.slice(-15), [
    "compose-render-lifecycle",
    "compose-review",
    "compose-provenance-stale",
    "episode-compose-preflight",
    "episode-compose-gates",
    "episode-compose-readonly",
    "episode-render-gates",
    "episode-render-playback",
    "episode-render-review",
    "episode-render-lifecycle",
    "episode-render-stale",
    "episode-render-isolation",
    "episode-export-download",
    "episode-export-gates",
    "episode-export-readonly",
  ]);
  const stages = requiredStages.map((name) => ({ name, status: "passed" }));
  assert.equal(acceptanceFailed({ stages, fatal: null, restoreError: null, composeDownFailed: false, cleanupError: null }).ok, true);
});

test("a missing lifecycle stage fails acceptance", () => {
  for (const name of ["media-cancel", "media-terminal-race", "media-observation-replay", "media-shot-isolation"]) {
    const stages = requiredStages.filter((stage) => stage !== name).map((stage) => ({ name: stage, status: "passed" }));
    const judgment = acceptanceFailed({ stages, fatal: null, restoreError: null, composeDownFailed: false, cleanupError: null });
    assert.equal(judgment.ok, false);
    assert.deepEqual(judgment.missing, [name]);
    assert.equal(acceptanceExitCode({ stages }), 1);
  }
});

test("skipped lifecycle stage fails acceptance", () => {
  const stages = requiredStages.map((name) => ({
    name,
    status: name === "media-shot-isolation" ? "skipped" : "passed",
  }));
  const judgment = acceptanceFailed({ stages, fatal: null, restoreError: null, composeDownFailed: false, cleanupError: null });
  assert.deepEqual(judgment.notPassed, ["media-shot-isolation"]);
});

test("cancel error contract does not require retryable false", () => {
  assert.deepEqual(assertCanceledError({ code: "CANCELED" }), { code: "CANCELED", retryable: null });
  assert.deepEqual(assertCanceledError({ code: "CANCELED", retryable: false }), { code: "CANCELED", retryable: false });
  assert.equal(assertCanceledError({ code: "CANCELED", retryable: false }).code, "CANCELED");
  assert.throws(() => assertCanceledError(null), /cancel error_json/);
  assert.throws(() => assertCanceledError({ code: "FAILED", retryable: false }), /cancel error_json/);
});

test("lock overlap requires the holder pid from pg_blocking_pids", () => {
  assert.deepEqual(blockerList("{42,7}"), ["42", "7"]);
  const matched = assertLockOverlap([
    { pid: 10, blockers: [4], wait_event_type: "Lock", wait_event: "transactionid", query: "SELECT id FROM generation_job" },
    { pid: 11, blockers: "{4,10}", query: "UPDATE generation_job" },
  ], 4, 2);
  assert.equal(matched.length, 2);
  assert.equal(matched[1].blockers[0], 4);
  assert.throws(() => assertLockOverlap([{ pid: 10, blockers: [9] }], 4, 1), /pg_blocking_pids/);
  const queued = assertLockOverlap([
    { pid: 96, blockers: [804], wait_event_type: "Lock", wait_event: "transactionid", query: "SELECT id FROM generation_job" },
    { pid: 805, blockers: [96], wait_event_type: "Lock", wait_event: "tuple", query: "SELECT id FROM generation_job" },
  ], 804, 2);
  assert.deepEqual(queued.map((row) => row.pid), [96, 805]);
});

test("terminal snapshot checks finished_at, workflow, assets, costs, and events", () => {
  const snapshot = {
    jobState: "CANCELED",
    workflowStatus: "CANCELED",
    attemptId: "attempt-1",
    requestId: "request-1",
    finishedAt: "2026-10-01T00:00:00.000Z",
    errorJson: { code: "CANCELED", retryable: null },
    responseSnapshot: null,
    assetIds: [],
    costIds: [],
    succeededEvents: 0,
    canceledEvents: 1,
    cancelRequestedEvents: 1,
  };
  assert.equal(assertTerminalSnapshot(snapshot, {
    jobState: "CANCELED",
    workflowStatus: "CANCELED",
    attemptId: "attempt-1",
    requestId: "request-1",
    errorCode: "CANCELED",
    responseSnapshot: null,
    assetIds: [],
    costIds: [],
    succeededEvents: 0,
    canceledEvents: 1,
    cancelRequestedEvents: 1,
  }).finishedAt, snapshot.finishedAt);
  assert.throws(() => assertTerminalSnapshot({ ...snapshot, finishedAt: null }, {
    jobState: "CANCELED",
    workflowStatus: "CANCELED",
  }), /finished_at/);
  assert.throws(() => assertTerminalSnapshot(snapshot, {
    jobState: "SUCCEEDED",
    workflowStatus: "CANCELED",
  }), /job state/);
});
