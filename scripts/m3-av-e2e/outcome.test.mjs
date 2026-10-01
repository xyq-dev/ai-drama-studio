import assert from "node:assert/strict";
import test from "node:test";
import { acceptanceExitCode, acceptanceFailed, assertLinkage, requiredStages } from "./outcome.mjs";

function passedStages() {
  return requiredStages.map((name) => ({ name, status: "passed" }));
}

function judgmentInput(overrides = {}) {
  return {
    stages: passedStages(),
    fatal: null,
    restoreError: null,
    composeDownFailed: false,
    cleanupError: null,
    ...overrides,
  };
}

function expectFailure(input) {
  const judgment = acceptanceFailed(input);
  assert.equal(judgment.ok, false);
  assert.equal(judgment.failed, true);
  assert.equal(acceptanceExitCode(input), 1);
  assert.equal(acceptanceExitCode(input), judgment.failed ? 1 : 0);
  return judgment;
}

test("a complete pass exits zero", () => {
  const input = judgmentInput({ notRun: ["成本冲突"] });
  const judgment = acceptanceFailed(input);
  assert.equal(judgment.ok, true);
  assert.equal(judgment.failed, false);
  assert.deepEqual(judgment.missing, []);
  assert.deepEqual(judgment.notPassed, []);
  assert.equal(acceptanceExitCode(input), 0);
});

test("fatal outside the stages fails the run", () => {
  const judgment = expectFailure(judgmentInput({ fatal: "setup failed before docker" }));
  assert.equal(judgment.fatal, "setup failed before docker");
});

test("fatal with no stages recorded still fails", () => {
  const judgment = expectFailure({
    stages: [],
    fatal: "cleanup crashed before results",
    restoreError: null,
    composeDownFailed: false,
    cleanupError: null,
  });
  assert.equal(judgment.missing.length, requiredStages.length);
});

test("a skipped required stage fails", () => {
  const stages = passedStages().map((stage) => stage.name === "playback" ? { ...stage, status: "skipped" } : stage);
  const judgment = expectFailure(judgmentInput({ stages }));
  assert.deepEqual(judgment.notPassed, ["playback"]);
});

test("a missing required stage fails", () => {
  const stages = passedStages().filter((stage) => stage.name !== "recovery-flag");
  const judgment = expectFailure(judgmentInput({ stages }));
  assert.deepEqual(judgment.missing, ["recovery-flag"]);
});

test("blocked and failed stages fail", () => {
  for (const status of ["blocked", "failed"]) {
    const stages = passedStages().map((stage) => stage.name === "compose" ? { ...stage, status } : stage);
    const judgment = expectFailure(judgmentInput({ stages }));
    assert.deepEqual(judgment.notPassed, ["compose"]);
  }
});

test("directory restore failure fails", () => {
  const judgment = expectFailure(judgmentInput({ restoreError: "rename failed" }));
  assert.equal(judgment.restoreError, "rename failed");
});

test("compose down failure fails", () => {
  const judgment = expectFailure(judgmentInput({ composeDownFailed: true }));
  assert.equal(judgment.composeDownFailed, true);
});

test("cleanup exception fails", () => {
  const judgment = expectFailure(judgmentInput({ cleanupError: "down timed out" }));
  assert.equal(judgment.cleanupError, "down timed out");
});

test("success linkage requires the same attempt and request", () => {
  const snapshot = {
    jobId: "job-1",
    jobErrorCode: null,
    attempt: {
      id: "attempt-1",
      attemptNo: 1,
      providerRequestId: "request-1",
      providerConfigurationId: "provider-1",
      finishedAt: "2026-10-01T00:00:00.000Z",
      errorJson: null,
    },
    asset: {
      sourceJobAttemptId: "attempt-1",
      sourceGenerationJobId: "job-1",
      providerRequestId: "request-1",
      providerConfigurationId: "provider-1",
    },
    cost: {
      jobAttemptId: "attempt-1",
      providerRequestId: "request-1",
      providerConfigurationId: "provider-1",
    },
    submitCallsMeasured: false,
  };
  assert.equal(assertLinkage(snapshot).attempt.id, "attempt-1");
});

test("cost job_attempt_id mismatch fails linkage", () => {
  assert.throws(() => assertLinkage({
    jobId: "job-1",
    attempt: {
      id: "attempt-1",
      attemptNo: 1,
      providerRequestId: "request-1",
      providerConfigurationId: "provider-1",
      finishedAt: "2026-10-01T00:00:00.000Z",
      errorJson: null,
    },
    asset: {
      sourceJobAttemptId: "attempt-1",
      sourceGenerationJobId: "job-1",
      providerRequestId: "request-1",
      providerConfigurationId: "provider-1",
    },
    cost: {
      jobAttemptId: "other-attempt",
      providerRequestId: "request-1",
      providerConfigurationId: "provider-1",
    },
  }), /cost job_attempt_id/);
});

test("a failed attempt must be finished, coded, and not retryable", () => {
  const base = {
    jobId: "job-1",
    jobErrorCode: "MOCK_AV_OUTPUT_INVALID",
    attempt: {
      id: "attempt-1",
      attemptNo: 1,
      providerRequestId: "request-1",
      providerConfigurationId: "provider-1",
      finishedAt: "2026-10-01T00:00:00.000Z",
      errorJson: { code: "MOCK_AV_OUTPUT_INVALID", retryable: false, message: "invalid" },
    },
    asset: null,
    cost: null,
    submitCallsMeasured: false,
  };
  assert.equal(assertLinkage(base, { expectAsset: false, expectCost: false, errorCode: "MOCK_AV_OUTPUT_INVALID" }).jobErrorCode, "MOCK_AV_OUTPUT_INVALID");
  assert.throws(() => assertLinkage({
    ...base,
    attempt: { ...base.attempt, finishedAt: null },
  }, { expectAsset: false, expectCost: false, errorCode: "MOCK_AV_OUTPUT_INVALID" }), /finished_at/);
  assert.throws(() => assertLinkage({
    ...base,
    attempt: { ...base.attempt, errorJson: { code: "MOCK_AV_OUTPUT_INVALID", retryable: true } },
  }, { expectAsset: false, expectCost: false, errorCode: "MOCK_AV_OUTPUT_INVALID" }), /retryable/);
});
