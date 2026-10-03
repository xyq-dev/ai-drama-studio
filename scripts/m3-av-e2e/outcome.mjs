export const requiredStages = [
  "docker",
  "compose",
  "identity",
  "migrate-provision",
  "processes",
  "source-chain",
  "page-submit",
  "subtitle-music",
  "playback",
  "content-headers",
  "png-draft-viewport",
  "idempotency-retry",
  "revision-history",
  "gates",
  "subtitle-music-gates",
  "mock-boundary",
  "subtitle-music-recovery",
  "recovery-disk",
  "recovery-flag",
  "image-recovery",
  "image-cost-guard",
  "media-cancel",
  "media-terminal-race",
  "media-observation-replay",
  "media-shot-isolation",
  "compose-preflight-page",
  "compose-preflight-gates",
  "compose-preflight-readonly",
  "compose-render-page",
  "compose-render-gates",
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
  "project-cost-summary",
  "project-cost-gates",
  "project-cost-readonly",
];

export function acceptanceFailed(input) {
  const stages = Array.isArray(input?.stages) ? input.stages : [];
  const byName = new Map(stages.map((stage) => [stage.name, stage]));
  const missing = requiredStages.filter((name) => !byName.has(name));
  const notPassed = requiredStages.filter((name) => byName.get(name)?.status !== "passed");
  const fatal = input?.fatal ? String(input.fatal) : null;
  const restoreError = input?.restoreError ? String(input.restoreError) : null;
  const cleanupError = input?.cleanupError ? String(input.cleanupError) : null;
  const composeDownFailed = input?.composeDownFailed === true;
  const failed = Boolean(fatal || restoreError || cleanupError || composeDownFailed || missing.length > 0 || notPassed.length > 0);
  return {
    ok: !failed,
    failed,
    fatal,
    restoreError,
    cleanupError,
    composeDownFailed,
    missing,
    notPassed,
  };
}

export function acceptanceExitCode(input) {
  return acceptanceFailed(input).failed ? 1 : 0;
}

export function assertLinkage(snapshot, options = {}) {
  const expectAsset = options.expectAsset !== false;
  const expectCost = options.expectCost !== false;
  const errorCode = options.errorCode ?? null;
  const problems = [];
  const attempt = snapshot?.attempt;
  if (!attempt?.id) problems.push("attempt id missing");
  if (!attempt?.finishedAt) problems.push("finished_at empty");
  if (attempt?.attemptNo !== 1) problems.push("attempt_no is not 1");
  if (expectAsset) {
    if (!snapshot.asset) problems.push("asset missing");
    else {
      if (String(snapshot.asset.sourceJobAttemptId) !== String(attempt?.id)) problems.push("asset source_job_attempt_id");
      if (String(snapshot.asset.sourceGenerationJobId) !== String(snapshot.jobId)) problems.push("asset source_generation_job_id");
      if (snapshot.asset.providerRequestId !== attempt?.providerRequestId) problems.push("asset provider_request_id");
      if (String(snapshot.asset.providerConfigurationId) !== String(attempt?.providerConfigurationId)) problems.push("asset provider_configuration_id");
    }
  } else if (snapshot?.asset) {
    problems.push("unexpected asset");
  }
  if (expectCost) {
    if (!snapshot.cost) problems.push("cost missing");
    else {
      if (String(snapshot.cost.jobAttemptId) !== String(attempt?.id)) problems.push("cost job_attempt_id");
      if (snapshot.cost.providerRequestId !== attempt?.providerRequestId) problems.push("cost provider_request_id");
      if (String(snapshot.cost.providerConfigurationId) !== String(attempt?.providerConfigurationId)) problems.push("cost provider_configuration_id");
    }
  } else if (snapshot?.cost) {
    problems.push("unexpected cost");
  }
  if (errorCode) {
    if (snapshot?.jobErrorCode !== errorCode) problems.push("job error_code");
    if (snapshot?.attempt?.errorJson?.code !== errorCode) problems.push("error_json.code");
    if (snapshot?.attempt?.errorJson?.retryable !== false) problems.push("error_json.retryable");
  }
  if (problems.length > 0) {
    const error = new Error(`ledger linkage: ${problems.join(", ")}`);
    error.snapshot = snapshot;
    throw error;
  }
  return snapshot;
}
