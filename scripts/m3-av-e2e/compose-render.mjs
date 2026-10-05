import { execFile } from "node:child_process";
import { renameSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { promisify } from "node:util";
import { createSideShot, replaceSideScene, waitForCurrentSources } from "./compose-preflight.mjs";

const execFileAsync = promisify(execFile);
const HOLD_BOUNDARY = "Lease-expiry late-result test. M4_COMPOSE_HOLD_BEFORE_COMMIT_MS stalls only attempt 1 after publish and before commitLocalCompose, without renewing the lease. It does not kill the worker. A hold longer than the 30s lease lets recovery queue a new attempt; the late commit is discarded and must not fail the new attempt.";
const KILL_BOUNDARY = "SIGKILL terminates the running worker. Encode, probe, and decode children set PR_SET_PDEATHSIG. Acceptance records the compose_cli PID and its ffmpeg or ffprobe child PIDs, then requires each recorded PID to exit.";
const LOCK_BOUNDARY = "A second database session holds FOR UPDATE on the compose job for 8s. This worker's compose lease is 4s and its query timeout is 10s. After the lock wait, the commit reads clock_timestamp() and cannot store the expired attempt.";
const COMMIT_BOUNDARY = "M4_COMPOSE_FAIL_INSIDE_COMMIT throws inside the success transaction after the asset, dependency, and asset.created statements. Those rows and job.succeeded roll back together.";

export async function composeRenderPage(ctx) {
  const panel = ctx.state.page.getByRole("region", { name: "Mock 单镜合成预检" });
  const start = panel.getByRole("button", { name: "开始合成" });
  if (await start.isDisabled()) throw new Error("compose submit stayed disabled after the current preflight");
  const responsePromise = ctx.state.page.waitForResponse((response) =>
    response.url().includes(`/shot-revisions/${ctx.state.world.shotRevisionId}/compose`)
    && !response.url().includes("compose-preflight")
    && response.request().method() === "POST",
  { timeout: 20_000 });
  await start.click();
  const response = await responsePromise;
  const accepted = await response.json();
  if (response.status() !== 202 || !accepted.jobId) throw new Error(`compose was not accepted ${response.status()}`);
  await panel.getByText("合成任务已受理").waitFor({ timeout: 10_000 });
  const job = await ctx.pollJob(accepted.jobId, 180_000);
  if (job.state !== "SUCCEEDED") throw new Error(`compose ${job.state} ${job.errorCode ?? ""} ${job.errorMessage ?? ""}`);
  const ledger = await ctx.jobLedger(accepted.jobId);
  const asset = ledger.assets[0];
  if (!asset || asset.kind !== "COMPOSITE" || asset.review_status !== "DRAFT" || asset.status !== "ACTIVE") {
    throw new Error(`composite asset ${JSON.stringify(asset)}`);
  }
  if (Number(asset.width) !== 1080 || Number(asset.height) !== 1920) throw new Error(`composite size ${asset.width}x${asset.height}`);
  if (asset.provider_configuration_id || asset.provider_request_id) throw new Error("composite recorded a provider");
  const card = panel.locator(`[data-composite-id="${asset.id}"]`);
  const video = card.locator("video");
  await video.waitFor({ state: "attached", timeout: 20_000 });
  const playback = await video.evaluate(async (node) => {
    const media = node;
    media.muted = true;
    if (media.readyState < 1) {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("loadedmetadata timeout")), 15000);
        media.addEventListener("loadedmetadata", () => { clearTimeout(timer); resolve(); }, { once: true });
      });
    }
    if (media.readyState < 2) {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("decoded frame timeout")), 15000);
        media.addEventListener("loadeddata", () => { clearTimeout(timer); resolve(); }, { once: true });
      });
    }
    const decoded = media.readyState >= 2;
    media.currentTime = 0.05;
    await new Promise((resolve) => media.addEventListener("seeked", () => resolve(), { once: true }));
    const canvas = document.createElement("canvas");
    canvas.width = media.videoWidth;
    canvas.height = media.videoHeight;
    const context = canvas.getContext("2d");
    context.drawImage(media, 0, 0);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let light = 0;
    for (let index = 0; index < pixels.length; index += 16) {
      if (pixels[index] > 40 || pixels[index + 1] > 40 || pixels[index + 2] > 40) light += 1;
    }
    await media.play();
    const progressed = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("playback did not advance")), 15000);
      const tick = () => {
        if (media.currentTime > 0.2) { clearTimeout(timer); resolve(media.currentTime); }
      };
      media.addEventListener("timeupdate", tick);
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("playback did not end")), 15000);
      media.addEventListener("ended", () => { clearTimeout(timer); resolve(); }, { once: true });
    });
    return { videoWidth: media.videoWidth, videoHeight: media.videoHeight, decoded, light, progressed, ended: media.ended };
  });
  if (!playback.decoded || playback.videoWidth !== 1080 || playback.videoHeight !== 1920 || playback.light < 8 || playback.progressed <= 0.2 || !playback.ended) {
    throw new Error(`playback ${JSON.stringify(playback)}`);
  }
  const shown = await card.innerText();
  if (!shown.includes("本地合成") || !shown.includes("Mock 来源") || !shown.includes("DRAFT") || !shown.includes("当前有效")) {
    throw new Error(`composite card ${shown}`);
  }
  if (await ctx.state.page.locator("#shot-action").inputValue() !== ctx.draftMarker) throw new Error("compose overwrote the shot draft");
  await ctx.state.page.setViewportSize({ width: 390, height: 844 });
  const overflow = await ctx.state.page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  await ctx.state.page.setViewportSize({ width: 1280, height: 900 });
  if (overflow > 1) throw new Error(`compose page overflow ${overflow}`);
  const stored = (await ctx.sql(`SELECT row_version FROM asset WHERE id = $1`, [asset.id]))[0];
  ctx.state.world.composite = { assetId: asset.id, jobId: accepted.jobId, checksum: asset.checksum_sha256, rowVersion: Number(stored.row_version) };
  return { assetId: asset.id, jobId: accepted.jobId, playback, overflow };
}

export async function composeRenderGates(ctx) {
  const selected = ctx.state.world.compose;
  const revisionId = ctx.state.world.shotRevisionId;
  const before = await tableCounts(ctx);
  const body = {
    videoAssetId: selected.videoId,
    audioAssetId: selected.audioId,
    musicAssetId: selected.musicId,
    subtitleAssetId: selected.subtitleId,
    expectedInputHash: "ab".repeat(32),
  };
  ctx.expectStatus(await ctx.callApi(ctx.apiOrigin, "POST", `/shot-revisions/${revisionId}/compose`, { body }), 409, "COMPOSE_INPUT_CHANGED");
  ctx.expectStatus(await ctx.callApi(ctx.apiOrigin, "POST", `/shot-revisions/${revisionId}/compose`, {
    body: { ...body, expectedInputHash: selected.inputHash, objectKey: "client/key.mp4" },
  }), 400, "VALIDATION_ERROR");
  const image = (await ctx.sql(
    `SELECT id::text AS id FROM asset WHERE workspace_id = $1 AND kind = 'IMAGE' AND status = 'ACTIVE' LIMIT 1`,
    [ctx.workspaceId],
  ))[0];
  ctx.expectStatus(await ctx.callApi(ctx.apiOrigin, "POST", `/shot-revisions/${revisionId}/compose`, {
    body: { videoAssetId: image.id, expectedInputHash: selected.inputHash },
  }), 400, "COMPOSE_INPUT_INVALID");
  const afterRejected = await tableCounts(ctx);
  if (JSON.stringify(before) !== JSON.stringify(afterRejected)) {
    throw new Error(`rejected compose created records ${JSON.stringify({ before, afterRejected })}`);
  }
  const side = await createSideShot(ctx);
  const preflight = ctx.expectStatus(await ctx.callApi(ctx.apiOrigin, "POST", `/shot-revisions/${side.revisionId}/compose-preflight`, {
    body: { videoAssetId: side.videoId },
  }), 200).body;
  await replaceSideScene(ctx, side);
  await waitForCurrentSources(ctx);
  const beforeSource = await tableCounts(ctx);
  ctx.expectStatus(await ctx.callApi(ctx.apiOrigin, "POST", `/shot-revisions/${side.revisionId}/compose`, {
    body: { videoAssetId: side.videoId, expectedInputHash: preflight.inputHash },
  }), 400, "REVIEW_REQUIRED");
  const names = [];
  try {
    ctx.spawnApp("api-render-off", ["pnpm", "--filter", "@ai-drama/api", "start"], ctx.appEnv({
      API_PORT: "3023",
      M4_LOCAL_COMPOSE_ENABLED: "false",
    }));
    ctx.spawnApp("api-render-prod", ["pnpm", "--filter", "@ai-drama/api", "start"], ctx.appEnv({
      API_PORT: "3024",
      NODE_ENV: "production",
      M4_LOCAL_COMPOSE_ENABLED: "true",
    }));
    const unsetEnv = ctx.childEnv({ API_PORT: "3025" }, ["M4_LOCAL_COMPOSE_ENABLED"]);
    if (Object.hasOwn(unsetEnv, "M4_LOCAL_COMPOSE_ENABLED")) throw new Error("unset did not remove M4_LOCAL_COMPOSE_ENABLED");
    ctx.spawnApp("api-render-unset", ["pnpm", "--filter", "@ai-drama/api", "start"], unsetEnv);
    ctx.spawnApp("api-render-other", ["pnpm", "--filter", "@ai-drama/api", "start"], ctx.appEnv({
      API_PORT: "3026",
      APP_WORKSPACE_ID: ctx.otherWorkspaceId,
      APP_WORKSPACE_NAME: "M4 render other",
    }));
    names.push("api-render-off", "api-render-prod", "api-render-unset", "api-render-other");
    for (const port of [3023, 3024, 3025, 3026]) {
      await ctx.waitHttp(`http://127.0.0.1:${port}/api/v1/health/ready`, (status, body) => status === 200 && body?.dependencies?.postgres?.status === "ok", 60_000);
    }
    const path = `/shot-revisions/${revisionId}/compose`;
    const current = { ...body, expectedInputHash: selected.inputHash };
    ctx.expectStatus(await ctx.callApi("http://127.0.0.1:3023", "POST", path, { body: current }), 400, "CONFIGURATION_ERROR");
    ctx.expectStatus(await ctx.callApi("http://127.0.0.1:3024", "POST", path, { body: current }), 400, "CONFIGURATION_ERROR");
    ctx.expectStatus(await ctx.callApi("http://127.0.0.1:3025", "POST", path, { body: current }), 400, "CONFIGURATION_ERROR");
    ctx.expectStatus(await ctx.callApi("http://127.0.0.1:3026", "POST", path, { body: current }), 404, "NOT_FOUND");
    const afterConfig = await tableCounts(ctx);
    if (JSON.stringify(beforeSource) !== JSON.stringify(afterConfig)) {
      throw new Error(`configuration or stale compose created records ${JSON.stringify({ beforeSource, afterConfig })}`);
    }
  } finally {
    for (const name of names) await ctx.stopApp(name);
  }
  const key = "compose-replay-same-request";
  const first = ctx.expectStatus(await ctx.callApi(ctx.apiOrigin, "POST", `/shot-revisions/${revisionId}/compose`, {
    key, body: { ...body, expectedInputHash: selected.inputHash },
  }), 202).body;
  const afterFirst = await tableCounts(ctx);
  const replay = ctx.expectStatus(await ctx.callApi(ctx.apiOrigin, "POST", `/shot-revisions/${revisionId}/compose`, {
    key, body: { ...body, expectedInputHash: selected.inputHash },
  }), 202).body;
  const afterReplay = await tableCounts(ctx);
  if (replay.jobId !== first.jobId || afterFirst.generation_job !== afterReplay.generation_job) {
    throw new Error("same key created a second compose job");
  }
  ctx.expectStatus(await ctx.callApi(ctx.apiOrigin, "POST", `/shot-revisions/${revisionId}/compose`, {
    key, body: { videoAssetId: selected.videoId, expectedInputHash: selected.inputHash },
  }), 409, "IDEMPOTENCY_KEY_REUSED");
  const replayJob = await ctx.pollJob(first.jobId, 180_000);
  return { replayJobId: first.jobId, replayState: replayJob.state, rejectedUnchanged: true };
}

export async function composeRenderLifecycle(ctx) {
  const late = await withHold(ctx, 40000, async () => {
    const shot = await createSideShot(ctx);
    const submitted = await submitVideoCompose(ctx, shot);
    const done = await ctx.pollJob(submitted.jobId, 180_000);
    const attempts = await ctx.sql(
      `SELECT attempt_no, id::text AS id FROM job_attempt WHERE generation_job_id = $1 ORDER BY attempt_no`,
      [submitted.jobId],
    );
    const assets = await ctx.sql(
      `SELECT source_job_attempt_id::text AS attempt_id FROM asset WHERE source_generation_job_id = $1`,
      [submitted.jobId],
    );
    if (done.state !== "SUCCEEDED" || attempts.length < 2 || assets.length !== 1 || assets[0].attempt_id !== attempts[attempts.length - 1].id) {
      throw new Error(`late recovery ${done.state} ${JSON.stringify({ attempts, assets })}`);
    }
    const succeeded = await ctx.sql(
      `SELECT count(*)::int AS count FROM domain_event WHERE event_type = 'job.succeeded' AND aggregate_id = $1`,
      [submitted.jobId],
    );
    if (succeeded[0].count !== 1) throw new Error(`late recovery wrote ${succeeded[0].count} success events`);
    return { jobId: submitted.jobId, attempts: attempts.length, assetAttempt: assets[0].attempt_id };
  });
  const canceled = await withHold(ctx, 8000, async () => {
    const shot = await createSideShot(ctx);
    const submitted = await submitVideoCompose(ctx, shot);
    await waitState(ctx, submitted.jobId, "RUNNING");
    ctx.expectStatus(await ctx.callApi(ctx.apiOrigin, "POST", `/generation-jobs/${submitted.jobId}/cancel`, { body: {} }), 200);
    const done = await ctx.pollJob(submitted.jobId, 60_000);
    const assets = await ctx.sql(`SELECT count(*)::int AS count FROM asset WHERE source_generation_job_id = $1`, [submitted.jobId]);
    if (done.state !== "CANCELED" || assets[0].count !== 0) throw new Error(`cancel-first ${done.state} assets ${assets[0].count}`);
    return { jobId: submitted.jobId, state: done.state };
  });
  const terminal = ctx.expectStatus(await ctx.callApi(ctx.apiOrigin, "POST", `/generation-jobs/${ctx.state.world.composite.jobId}/cancel`, { body: {} }), 409, "JOB_TERMINAL");
  const staleDuring = await withHold(ctx, 25000, async () => {
    const shot = await createSideShot(ctx);
    const submitted = await submitVideoCompose(ctx, shot);
    await waitState(ctx, submitted.jobId, "RUNNING");
    await replaceSideScene(ctx, shot);
    const done = await ctx.pollJob(submitted.jobId, 90_000);
    const assets = await ctx.sql(`SELECT count(*)::int AS count FROM asset WHERE source_generation_job_id = $1`, [submitted.jobId]);
    if (done.state !== "FAILED" || assets[0].count !== 0) throw new Error(`source changed during compose ${done.state} assets ${assets[0].count}`);
    return { jobId: submitted.jobId, errorCode: done.errorCode };
  });
  const killed = await killRunningWorker(ctx);
  const locked = await lockAcrossLease(ctx);
  const injected = await injectCommitFailure(ctx);
  const missing = await createSideShot(ctx);
  await ctx.stopApp("worker");
  const queued = await submitVideoCompose(ctx, missing);
  const stored = (await ctx.sql(`SELECT object_key FROM asset WHERE id = $1`, [missing.videoId]))[0];
  const absolute = join(ctx.mockDir, stored.object_key);
  const parked = `${absolute}.parked`;
  renameSync(absolute, parked);
  try {
    await ctx.startWorker();
    const failed = await ctx.pollJob(queued.jobId, 90_000);
    const assets = await ctx.sql(`SELECT count(*)::int AS count FROM asset WHERE source_generation_job_id = $1`, [queued.jobId]);
    const events = await ctx.sql(
      `SELECT count(*)::int AS count FROM domain_event WHERE event_type = 'job.succeeded' AND aggregate_id = $1`,
      [queued.jobId],
    );
    if (failed.state !== "FAILED" || assets[0].count !== 0 || events[0].count !== 0) {
      throw new Error(`missing file ${failed.state} ${failed.errorCode} assets ${assets[0].count} events ${events[0].count}`);
    }
    ctx.expectStatus(await ctx.callApi(ctx.apiOrigin, "POST", `/generation-jobs/${queued.jobId}/retry`, { body: {} }), 409, "JOB_NOT_RETRYABLE");
    return {
      hold: HOLD_BOUNDARY, late, canceled, terminal: terminal.body.error.code, staleDuring,
      killed, locked, injected, missingFile: failed.errorCode,
    };
  } finally {
    renameSync(parked, absolute);
    await ctx.stopApp("worker");
    await ctx.startWorker();
  }
}

export async function composeReview(ctx) {
  const pageAsset = ctx.state.world.composite;
  const current = await assetReview(ctx, pageAsset.assetId);
  ctx.expectStatus(await ctx.callApi(ctx.apiOrigin, "POST", `/assets/${pageAsset.assetId}/review`, {
    ifMatch: Number(current.row_version) + 1,
    body: { decision: "APPROVE", note: "", contentHash: current.checksum_sha256 },
  }), 409, "REVISION_CONFLICT");
  ctx.expectStatus(await ctx.callApi(ctx.apiOrigin, "POST", `/assets/${pageAsset.assetId}/review`, {
    ifMatch: current.row_version,
    body: { decision: "APPROVE", note: "", contentHash: "cd".repeat(32) },
  }), 409, "COMPOSE_CONTENT_HASH_MISMATCH");
  ctx.expectStatus(await ctx.callApi(ctx.apiOrigin, "POST", `/assets/${ctx.state.world.compose.videoId}/review`, {
    ifMatch: 1,
    body: { decision: "APPROVE", note: "", contentHash: current.checksum_sha256 },
  }), 409, "REVIEW_INVALID_TRANSITION");
  const key = "compose-review-approve-once";
  const approved = ctx.expectStatus(await ctx.callApi(ctx.apiOrigin, "POST", `/assets/${pageAsset.assetId}/review`, {
    key, ifMatch: current.row_version,
    body: { decision: "APPROVE", note: "page cut", contentHash: current.checksum_sha256 },
  }), 200).body;
  const replay = ctx.expectStatus(await ctx.callApi(ctx.apiOrigin, "POST", `/assets/${pageAsset.assetId}/review`, {
    key, ifMatch: current.row_version,
    body: { decision: "APPROVE", note: "page cut", contentHash: current.checksum_sha256 },
  }), 200).body;
  if (replay.rowVersion !== approved.rowVersion) throw new Error("review replay changed the row version");
  const events = await ctx.sql(
    `SELECT count(*)::int AS count FROM domain_event WHERE event_type = 'asset.reviewed' AND aggregate_id = $1`,
    [pageAsset.assetId],
  );
  if (events[0].count !== 1) throw new Error(`approve replay wrote ${events[0].count} events`);
  const bytes = await assetReview(ctx, pageAsset.assetId);
  if (bytes.checksum_sha256 !== current.checksum_sha256 || bytes.review_status !== "APPROVED") {
    throw new Error(`approve changed bytes or status ${JSON.stringify(bytes)}`);
  }
  ctx.expectStatus(await ctx.callApi(ctx.apiOrigin, "POST", `/assets/${pageAsset.assetId}/review`, {
    ifMatch: bytes.row_version,
    body: { decision: "REJECT", note: "reverse", contentHash: bytes.checksum_sha256 },
  }), 409, "REVIEW_INVALID_TRANSITION");
  const rejected = await reviewFreshComposite(ctx, "REJECT", "return this cut");
  const race = await createFreshComposite(ctx);
  const left = ctx.callApi(ctx.apiOrigin, "POST", `/assets/${race.assetId}/review`, {
    ifMatch: race.rowVersion,
    body: { decision: "APPROVE", note: "left", contentHash: race.checksum },
  });
  const right = ctx.callApi(ctx.apiOrigin, "POST", `/assets/${race.assetId}/review`, {
    ifMatch: race.rowVersion,
    body: { decision: "REJECT", note: "right", contentHash: race.checksum },
  });
  const results = await Promise.all([left, right]);
  const statuses = results.map((item) => item.status).sort();
  if (statuses.join(",") !== "200,409" && statuses.join(",") !== "200,400") {
    throw new Error(`concurrent review ${JSON.stringify(results.map((item) => item.status))}`);
  }
  const winner = await assetReview(ctx, race.assetId);
  const winnerEvents = await ctx.sql(
    `SELECT count(*)::int AS count FROM domain_event WHERE event_type = 'asset.reviewed' AND aggregate_id = $1`,
    [race.assetId],
  );
  if (winnerEvents[0].count !== 1 || !["APPROVED", "REJECTED"].includes(winner.review_status)) {
    throw new Error(`concurrent review stored ${winner.review_status} events ${winnerEvents[0].count}`);
  }
  const blocked = await createFreshComposite(ctx);
  const side = blocked.shot;
  await replaceSideScene(ctx, side);
  await waitForCurrentSources(ctx);
  const stale = await assetReview(ctx, blocked.assetId);
  if (stale.status !== "STALE" || stale.review_status !== "DRAFT" || stale.checksum_sha256 !== blocked.checksum) {
    throw new Error(`source change did not stale the draft composite ${stale.status} ${stale.review_status}`);
  }
  ctx.expectStatus(await ctx.callApi(ctx.apiOrigin, "POST", `/assets/${blocked.assetId}/review`, {
    ifMatch: stale.row_version,
    body: { decision: "APPROVE", note: "", contentHash: stale.checksum_sha256 },
  }), 409, "REVIEW_INVALID_TRANSITION");
  ctx.state.world.composite = { ...pageAsset, rowVersion: approved.rowVersion, reviewStatus: "APPROVED" };
  return { approved: approved.reviewStatus, rejected: rejected.reviewStatus, race: winner.review_status };
}

export async function composeProvenanceStale(ctx) {
  const assetId = ctx.state.world.composite.assetId;
  const before = await assetReview(ctx, assetId);
  if (before.review_status !== "APPROVED" || before.status !== "ACTIVE") throw new Error(`composite was not an active approval ${before.status} ${before.review_status}`);
  const edges = await ctx.sql(
    `SELECT
       (SELECT count(*)::int FROM asset_dependency WHERE dependent_asset_id = $1) AS assets,
       (SELECT count(*)::int FROM asset_revision_dependency WHERE dependent_asset_id = $1) AS revisions`,
    [assetId],
  );
  if (edges[0].assets < 1 || edges[0].revisions < 1) throw new Error(`missing compose edges ${JSON.stringify(edges[0])}`);
  const aggregate = ctx.expectStatus(await ctx.callApi(
    ctx.apiOrigin, "GET",
    `/projects/${ctx.state.world.projectId}/episodes/${ctx.state.world.episodeId}/scenes/${ctx.state.world.sceneId}/shots/${ctx.state.world.shotId}/revisions`,
  ), 200).body.aggregate;
  ctx.expectStatus(await ctx.callApi(
    ctx.apiOrigin, "POST",
    `/projects/${ctx.state.world.projectId}/episodes/${ctx.state.world.episodeId}/scenes/${ctx.state.world.sceneId}/shots/${ctx.state.world.shotId}/revisions`,
    { ifMatch: aggregate.rowVersion, body: ctx.shotPayload(ctx.state.world.sceneRevisionId, 1, "compose-stale-source", ctx.promptText, ctx.dialogueText) },
  ), 201);
  await waitForCurrentSources(ctx);
  const started = Date.now();
  let stale = before;
  while (Date.now() - started < 30_000) {
    stale = await assetReview(ctx, assetId);
    if (stale.status === "STALE") break;
    await ctx.sleep(500);
  }
  if (stale.status !== "STALE" || stale.review_status !== "APPROVED" || stale.checksum_sha256 !== before.checksum_sha256 || !stale.reviewed_by) {
    throw new Error(`stale review history ${JSON.stringify(stale)}`);
  }
  const panel = ctx.state.page.getByRole("region", { name: "Mock 单镜合成预检" });
  const approvedCard = panel.locator(`[data-composite-id="${assetId}"]`);
  await approvedCard.getByText("审核 APPROVED · 历史成片").waitFor({ timeout: 20_000 });
  const text = await panel.innerText();
  if (!text.includes("APPROVED") || !text.includes("历史成片") || text.includes("当前有效")) {
    throw new Error(`page did not separate approval from validity ${text}`);
  }
  if (await ctx.state.page.locator("#shot-action").inputValue() !== ctx.draftMarker) throw new Error("stale refresh overwrote the shot draft");
  return { assetId, status: stale.status, reviewStatus: stale.review_status, edges: edges[0] };
}

async function killRunningWorker(ctx) {
  const shot = await createSideShot(ctx);
  const submitted = await submitVideoCompose(ctx, shot);
  const watchedPromise = waitForMediaTree();
  try {
    await waitState(ctx, submitted.jobId, "RUNNING");
  } catch (error) {
    watchedPromise.catch(() => undefined);
    throw error;
  }
  const watched = await watchedPromise;
  const app = ctx.state.apps.find((item) => item.name === "worker");
  if (!app?.pid) throw new Error("worker pid is missing");
  try { process.kill(process.platform === "linux" ? -app.pid : app.pid, "SIGKILL"); } catch { /* the stop below confirms it is gone */ }
  await ctx.stopApp("worker");
  for (const pid of [watched.cli, ...watched.media]) {
    const started = Date.now();
    let alive = true;
    while (Date.now() - started < 15_000) {
      alive = await pidAlive(pid);
      if (!alive) break;
      await ctx.sleep(200);
    }
    if (alive) throw new Error(`media pid ${pid} survived the killed worker`);
  }
  try {
    await ctx.startWorker();
    const done = await ctx.pollJob(submitted.jobId, 180_000);
    const attempts = await ctx.sql(
      `SELECT attempt_no, id::text AS id FROM job_attempt WHERE generation_job_id = $1 ORDER BY attempt_no`,
      [submitted.jobId],
    );
    const assets = await ctx.sql(
      `SELECT source_job_attempt_id::text AS attempt_id FROM asset WHERE source_generation_job_id = $1`,
      [submitted.jobId],
    );
    const succeeded = await ctx.sql(
      `SELECT count(*)::int AS count FROM domain_event WHERE event_type = 'job.succeeded' AND aggregate_id = $1`,
      [submitted.jobId],
    );
    if (done.state !== "SUCCEEDED" || attempts.length < 2 || assets.length !== 1 || assets[0].attempt_id !== attempts.at(-1).id || succeeded[0].count !== 1) {
      throw new Error(`killed worker recovery ${done.state} ${JSON.stringify({ attempts, assets, succeeded: succeeded[0].count })}`);
    }
    return {
      boundary: KILL_BOUNDARY,
      jobId: submitted.jobId,
      attempts: attempts.length,
      assetAttempt: assets[0].attempt_id,
      successEvents: succeeded[0].count,
      cliPid: watched.cli,
      mediaPids: watched.media,
    };
  } finally {
    if (!ctx.state.apps.some((item) => item.name === "worker")) await ctx.startWorker();
  }
}

async function lockAcrossLease(ctx) {
  return withWorkerEnv(ctx, { M4_COMPOSE_LEASE_MS: "4000" }, async () => {
    const shot = await createSideShot(ctx);
    const submitted = await submitVideoCompose(ctx, shot);
    await waitState(ctx, submitted.jobId, "RUNNING");
    const attempt = (await ctx.sql(
      `SELECT id::text AS id FROM job_attempt WHERE generation_job_id = $1 AND finished_at IS NULL ORDER BY attempt_no DESC LIMIT 1`,
      [submitted.jobId],
    ))[0];
    await holdJobLock(ctx, submitted.jobId, 8_000);
    const done = await ctx.pollJob(submitted.jobId, 180_000);
    const assets = await ctx.sql(
      `SELECT source_job_attempt_id::text AS attempt_id FROM asset WHERE source_generation_job_id = $1`,
      [submitted.jobId],
    );
    const expiredAsset = assets.filter((row) => row.attempt_id === attempt.id);
    if (expiredAsset.length !== 0) throw new Error(`expired attempt stored an asset ${JSON.stringify(assets)}`);
    if (done.state === "SUCCEEDED" && (assets.length !== 1 || assets[0].attempt_id === attempt.id)) {
      throw new Error(`lock recovery asset ${JSON.stringify(assets)}`);
    }
    if (done.state !== "SUCCEEDED" && done.state !== "FAILED") throw new Error(`lock wait ended ${done.state}`);
    return { boundary: LOCK_BOUNDARY, jobId: submitted.jobId, state: done.state, expiredAttempt: attempt.id, assets: assets.length };
  });
}

async function injectCommitFailure(ctx) {
  return withWorkerEnv(ctx, { M4_COMPOSE_FAIL_INSIDE_COMMIT: "true" }, async () => {
    const shot = await createSideShot(ctx);
    const submitted = await submitVideoCompose(ctx, shot);
    const done = await ctx.pollJob(submitted.jobId, 180_000);
    const assets = await ctx.sql(`SELECT count(*)::int AS count FROM asset WHERE source_generation_job_id = $1`, [submitted.jobId]);
    const dependencies = await ctx.sql(
      `SELECT count(*)::int AS count FROM asset_dependency WHERE dependent_asset_id IN (SELECT id FROM asset WHERE source_generation_job_id = $1)`,
      [submitted.jobId],
    );
    const created = await ctx.sql(
      `SELECT count(*)::int AS count FROM domain_event WHERE event_type = 'asset.created' AND payload_json->>'jobId' = $1`,
      [submitted.jobId],
    );
    const succeeded = await ctx.sql(
      `SELECT count(*)::int AS count FROM domain_event WHERE event_type = 'job.succeeded' AND aggregate_id = $1`,
      [submitted.jobId],
    );
    if (done.state !== "FAILED" || assets[0].count !== 0 || dependencies[0].count !== 0 || created[0].count !== 0 || succeeded[0].count !== 0) {
      throw new Error(`injected commit ${done.state} ${done.errorCode} assets ${assets[0].count} deps ${dependencies[0].count} created ${created[0].count} succeeded ${succeeded[0].count}`);
    }
    return { boundary: COMMIT_BOUNDARY, jobId: submitted.jobId, errorCode: done.errorCode };
  });
}

async function withWorkerEnv(ctx, env, run) {
  await ctx.stopApp("worker");
  ctx.spawnApp("worker", ["pnpm", "--filter", "@ai-drama/worker", "start"], ctx.appEnv(env));
  await ctx.waitHttp(`${ctx.workerOrigin}/health/ready`, (status, body) => status === 200 && body?.dependencies?.queue?.status === "ok", 60_000);
  try {
    return await run();
  } finally {
    await ctx.stopApp("worker");
    await ctx.startWorker();
  }
}

async function holdJobLock(ctx, jobId, ms) {
  const require = createRequire(join(ctx.repo, "packages/database/package.json"));
  const { Client } = require("pg");
  const client = new Client({ connectionString: ctx.databaseUrl, statement_timeout: 0 });
  await client.connect();
  try {
    await client.query("BEGIN");
    const held = await client.query("SELECT state, lease_until > clock_timestamp() AS current FROM generation_job WHERE id = $1 FOR UPDATE", [jobId]);
    if (held.rows[0]?.state !== "RUNNING" || held.rows[0]?.current !== true) {
      throw new Error(`lock missed the live lease ${JSON.stringify(held.rows[0])}`);
    }
    await ctx.sleep(ms);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

async function waitForMediaTree() {
  const started = Date.now();
  while (Date.now() - started < 60_000) {
    const rows = await processRows();
    const cli = rows.find((row) => row.args.includes("media_worker.compose_cli"));
    if (cli) {
      const descendants = descendantPids(rows, cli.pid);
      const media = rows.filter((row) => descendants.includes(row.pid) && /\b(ffmpeg|ffprobe)\b/.test(row.args)).map((row) => row.pid);
      if (media.length > 0) return { cli: cli.pid, media };
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("compose renderer process tree was not visible before the worker was killed");
}

function descendantPids(rows, root) {
  const children = new Map();
  for (const row of rows) {
    const list = children.get(row.ppid) ?? [];
    list.push(row.pid);
    children.set(row.ppid, list);
  }
  const found = [];
  const walk = (pid) => {
    for (const child of children.get(pid) ?? []) {
      found.push(child);
      walk(child);
    }
  };
  walk(root);
  return found;
}

async function processRows() {
  const { stdout } = await execFileAsync("ps", ["-eo", "pid=,ppid=,args="]);
  return stdout.split("\n").flatMap((line) => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
    return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), args: match[3] }] : [];
  });
}

async function pidAlive(pid) {
  try {
    const { stdout } = await execFileAsync("ps", ["-p", String(pid), "-o", "pid="]);
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

async function withHold(ctx, holdMs, run) {
  await ctx.stopApp("worker");
  ctx.spawnApp("worker", ["pnpm", "--filter", "@ai-drama/worker", "start"], ctx.appEnv({
    M4_COMPOSE_HOLD_BEFORE_COMMIT_MS: String(holdMs),
  }));
  await ctx.waitHttp(`${ctx.workerOrigin}/health/ready`, (status, body) => status === 200 && body?.dependencies?.queue?.status === "ok", 60_000);
  try {
    return await run();
  } finally {
    await ctx.stopApp("worker");
    await ctx.startWorker();
  }
}

async function submitVideoCompose(ctx, shot) {
  const preflight = ctx.expectStatus(await ctx.callApi(ctx.apiOrigin, "POST", `/shot-revisions/${shot.revisionId}/compose-preflight`, {
    body: { videoAssetId: shot.videoId },
  }), 200).body;
  const accepted = ctx.expectStatus(await ctx.callApi(ctx.apiOrigin, "POST", `/shot-revisions/${shot.revisionId}/compose`, {
    body: { videoAssetId: shot.videoId, expectedInputHash: preflight.inputHash },
  }), 202).body;
  return { ...shot, jobId: accepted.jobId, inputHash: preflight.inputHash };
}

async function waitState(ctx, jobId, state) {
  const started = Date.now();
  while (Date.now() - started < 60_000) {
    const job = ctx.expectStatus(await ctx.callApi(ctx.apiOrigin, "GET", `/generation-jobs/${jobId}`), 200).body;
    if (job.state === state) return job;
    if (job.state === "SUCCEEDED" || job.state === "FAILED" || job.state === "CANCELED") {
      throw new Error(`job reached ${job.state} before ${state}`);
    }
    await ctx.sleep(300);
  }
  throw new Error(`job did not reach ${state}`);
}

async function createFreshComposite(ctx) {
  const shot = await createSideShot(ctx);
  const submitted = await submitVideoCompose(ctx, shot);
  const done = await ctx.pollJob(submitted.jobId, 180_000);
  if (done.state !== "SUCCEEDED") throw new Error(`fresh compose ${done.state} ${done.errorCode ?? ""}`);
  const asset = (await ctx.sql(
    `SELECT id::text AS id, row_version, checksum_sha256 FROM asset WHERE source_generation_job_id = $1`,
    [submitted.jobId],
  ))[0];
  return { shot, assetId: asset.id, rowVersion: Number(asset.row_version), checksum: asset.checksum_sha256 };
}

async function reviewFreshComposite(ctx, decision, note) {
  const fresh = await createFreshComposite(ctx);
  return ctx.expectStatus(await ctx.callApi(ctx.apiOrigin, "POST", `/assets/${fresh.assetId}/review`, {
    ifMatch: fresh.rowVersion,
    body: { decision, note, contentHash: fresh.checksum },
  }), 200).body;
}

async function assetReview(ctx, assetId) {
  const rows = await ctx.sql(
    `SELECT status, review_status, row_version, checksum_sha256, reviewed_by::text AS reviewed_by
       FROM asset WHERE id = $1`,
    [assetId],
  );
  return rows[0];
}

async function tableCounts(ctx) {
  const tables = ["generation_job", "job_attempt", "workflow_run", "dispatch_outbox", "domain_event", "asset"];
  const counts = {};
  for (const table of tables) {
    const rows = await ctx.sql(`SELECT COUNT(*)::int AS count FROM ${table}`);
    counts[table] = rows[0].count;
  }
  return counts;
}
