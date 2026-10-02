import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { join } from "node:path";
import { promisify } from "node:util";
import { createSideShot, replaceSideScene, waitForCurrentSources } from "./compose-preflight.mjs";

const execFileAsync = promisify(execFile);
const KILL_BOUNDARY = "SIGKILL terminates the running worker. Episode encode, probe, and decode children set PR_SET_PDEATHSIG. Acceptance records the episode_compose PID and its ffmpeg or ffprobe child PIDs, then requires each recorded PID to exit.";
const LOCK_BOUNDARY = "A second database session holds FOR UPDATE on the episode compose job for 8s. This worker's compose lease is 4s. After the lock wait, the commit reads clock_timestamp() and cannot store the expired attempt.";
const COMMIT_BOUNDARY = "M4_COMPOSE_FAIL_INSIDE_COMMIT throws inside the episode success transaction after the asset, dependency, and success statements. Those rows roll back together.";

export async function episodeRenderGates(ctx) {
  const pair = await approvedPair(ctx);
  ctx.state.episodeRender = pair;
  const path = `/projects/${ctx.state.world.projectId}/episodes/${pair.episodeId}/compose`;
  const draft = await shotComposite(ctx, await createSideShot(ctx), {}, false);
  const staleShot = await createSideShot(ctx);
  const staleComposite = await shotComposite(ctx, staleShot, {}, true);
  await replaceSideScene(ctx, staleShot);
  await waitForCurrentSources(ctx);
  const before = await tableCounts(ctx);
  ctx.expectStatus(await ctx.callApi(ctx.apiOrigin, "POST", path, {
    body: { compositeAssetIds: [pair.plain.assetId, pair.burned.assetId], expectedInputHash: "ab".repeat(32) },
  }), 409, "COMPOSE_INPUT_CHANGED");
  ctx.expectStatus(await ctx.callApi(ctx.apiOrigin, "POST", path, {
    body: { compositeAssetIds: [pair.plain.assetId, pair.burned.assetId], expectedInputHash: pair.inputHash, objectKey: "client/out.mp4" },
  }), 400, "VALIDATION_ERROR");
  ctx.expectStatus(await ctx.callApi(ctx.apiOrigin, "POST", path, {
    body: { compositeAssetIds: [pair.plain.assetId, draft.assetId], expectedInputHash: pair.inputHash },
  }), 400, "COMPOSE_INPUT_INVALID");
  const otherEpisode = (await episodes(ctx)).find((item) => item.episodeNo === 2);
  ctx.expectStatus(await ctx.callApi(ctx.apiOrigin, "POST", `/projects/${ctx.state.world.projectId}/episodes/${otherEpisode.id}/compose`, {
    body: { compositeAssetIds: [pair.plain.assetId, pair.burned.assetId], expectedInputHash: pair.inputHash },
  }), 400, "COMPOSE_INPUT_INVALID");
  const staleAttempt = await ctx.callApi(ctx.apiOrigin, "POST", path, {
    body: { compositeAssetIds: [pair.plain.assetId, staleComposite.assetId], expectedInputHash: pair.inputHash },
  });
  if (staleAttempt.status !== 400 || !["COMPOSE_INPUT_INVALID", "REVIEW_REQUIRED"].includes(staleAttempt.body?.error?.code)) {
    throw new Error(`stale episode source was accepted ${staleAttempt.status} ${staleAttempt.body?.error?.code}`);
  }
  const afterRejected = await tableCounts(ctx);
  if (before.generation_job !== afterRejected.generation_job || before.dispatch_outbox !== afterRejected.dispatch_outbox) {
    throw new Error(`rejected episode compose created jobs ${JSON.stringify({ before, afterRejected })}`);
  }
  const names = [];
  try {
    ctx.spawnApp("api-episode-off", ["pnpm", "--filter", "@ai-drama/api", "start"], ctx.appEnv({
      API_PORT: "3031",
      M4_LOCAL_EPISODE_COMPOSE_ENABLED: "false",
    }));
    ctx.spawnApp("api-episode-prod", ["pnpm", "--filter", "@ai-drama/api", "start"], ctx.appEnv({
      API_PORT: "3032",
      NODE_ENV: "production",
      M4_LOCAL_EPISODE_COMPOSE_ENABLED: "true",
    }));
    const unsetEnv = ctx.childEnv({ API_PORT: "3033" }, ["M4_LOCAL_EPISODE_COMPOSE_ENABLED"]);
    if (Object.hasOwn(unsetEnv, "M4_LOCAL_EPISODE_COMPOSE_ENABLED")) throw new Error("unset did not remove the episode compose switch");
    ctx.spawnApp("api-episode-unset", ["pnpm", "--filter", "@ai-drama/api", "start"], unsetEnv);
    ctx.spawnApp("api-episode-other", ["pnpm", "--filter", "@ai-drama/api", "start"], ctx.appEnv({
      API_PORT: "3034",
      APP_WORKSPACE_ID: ctx.otherWorkspaceId,
      APP_WORKSPACE_NAME: "M4 episode other",
    }));
    names.push("api-episode-off", "api-episode-prod", "api-episode-unset", "api-episode-other");
    for (const port of [3031, 3032, 3033, 3034]) {
      await ctx.waitHttp(`http://127.0.0.1:${port}/api/v1/health/ready`, (status, body) => status === 200 && body?.dependencies?.postgres?.status === "ok", 60_000);
    }
    const current = { compositeAssetIds: [pair.plain.assetId, pair.burned.assetId], expectedInputHash: pair.inputHash };
    for (const base of ["http://127.0.0.1:3031", "http://127.0.0.1:3032", "http://127.0.0.1:3033"]) {
      ctx.expectStatus(await ctx.callApi(base, "POST", path, { body: current }), 400, "CONFIGURATION_ERROR");
    }
    ctx.expectStatus(await ctx.callApi("http://127.0.0.1:3034", "POST", path, { body: current }), 404, "NOT_FOUND");
  } finally {
    for (const name of names) await ctx.stopApp(name);
  }
  const afterConfig = await tableCounts(ctx);
  if (afterConfig.generation_job !== afterRejected.generation_job || afterConfig.dispatch_outbox !== afterRejected.dispatch_outbox) {
    throw new Error("disabled episode compose created a job");
  }
  const key = "episode-compose-replay";
  const first = ctx.expectStatus(await ctx.callApi(ctx.apiOrigin, "POST", path, { key, body: {
    compositeAssetIds: [pair.plain.assetId, pair.burned.assetId],
    expectedInputHash: pair.inputHash,
  } }), 202).body;
  const replay = ctx.expectStatus(await ctx.callApi(ctx.apiOrigin, "POST", path, { key, body: {
    compositeAssetIds: [pair.plain.assetId, pair.burned.assetId],
    expectedInputHash: pair.inputHash,
  } }), 202).body;
  if (replay.jobId !== first.jobId) throw new Error("same episode key created a second job");
  ctx.expectStatus(await ctx.callApi(ctx.apiOrigin, "POST", path, { key, body: {
    compositeAssetIds: [pair.burned.assetId, pair.plain.assetId],
    expectedInputHash: pair.inputHash,
  } }), 409, "IDEMPOTENCY_KEY_REUSED");
  const accepted = await ctx.pollJob(first.jobId, 180_000);
  if (accepted.state !== "SUCCEEDED") throw new Error(`episode replay ${accepted.state} ${accepted.errorCode ?? ""}`);
  const shotWhileOff = await withWorkerEnv(ctx, {}, ["M4_LOCAL_EPISODE_COMPOSE_ENABLED"], async () => {
    const shot = await createSideShot(ctx);
    const submitted = await shotComposite(ctx, shot, {}, false);
    const done = await ctx.pollJob(submitted.jobId, 180_000);
    if (done.state !== "SUCCEEDED") throw new Error(`shot compose with episode switch off ${done.state} ${done.errorCode ?? ""}`);
    return { jobId: submitted.jobId, state: done.state };
  });
  const withoutMock = await episodeWithoutMockDir(ctx);
  return { jobId: first.jobId, shotWhileOff, plain: pair.plain.assetId, burned: pair.burned.assetId, withoutMock };
}

export async function episodeRenderPlayback(ctx) {
  const pair = ctx.state.episodeRender;
  if (!pair) throw new Error("episode render sources were not prepared");
  const forward = await submitEpisode(ctx, [pair.plain.assetId, pair.burned.assetId]);
  const reverse = await submitEpisode(ctx, [pair.burned.assetId, pair.plain.assetId]);
  const forwardDone = await ctx.pollJob(forward.jobId, 180_000);
  const reverseDone = await ctx.pollJob(reverse.jobId, 180_000);
  if (forwardDone.state !== "SUCCEEDED" || reverseDone.state !== "SUCCEEDED") {
    throw new Error(`episode playback jobs ${forwardDone.state} ${reverseDone.state}`);
  }
  const forwardAsset = await episodeAsset(ctx, forward.jobId);
  const reverseAsset = await episodeAsset(ctx, reverse.jobId);
  const forwardOrder = await frameOrder(ctx, forwardAsset, pair);
  const reverseOrder = await frameOrder(ctx, reverseAsset, pair);
  if (!forwardOrder.secondBrighter || !reverseOrder.firstBrighter) {
    throw new Error(`frame order ${JSON.stringify({ forwardOrder, reverseOrder })}`);
  }
  if (forwardAsset.source_shot_revision_id !== null || reverseAsset.source_shot_revision_id !== null) {
    throw new Error("episode asset used a shot source");
  }
  const page = ctx.state.page;
  await page.goto(`${ctx.webOrigin}/projects/${ctx.state.world.projectId}?focus=episode-compose&episode=1`, { waitUntil: "domcontentloaded", timeout: 30_000 });
  const card = page.locator(`[data-composite-id="${forwardAsset.id}"]`);
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
    await media.play();
    const progressed = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("playback did not advance")), 15000);
      const tick = () => {
        if (media.currentTime > 0.2) { clearTimeout(timer); resolve(media.currentTime); }
      };
      media.addEventListener("timeupdate", tick);
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("playback did not end")), 20000);
      media.addEventListener("ended", () => { clearTimeout(timer); resolve(); }, { once: true });
    });
    return { decoded: media.readyState >= 2, width: media.videoWidth, height: media.videoHeight, progressed, ended: media.ended };
  });
  if (!playback.decoded || playback.width !== 1080 || playback.height !== 1920 || playback.progressed <= 0.2 || !playback.ended) {
    throw new Error(`episode playback ${JSON.stringify(playback)}`);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  await page.screenshot({ path: join(ctx.outputDir, "episode-render-390.png"), fullPage: true });
  await page.setViewportSize({ width: 1280, height: 900 });
  if (overflow > 1) throw new Error(`episode render overflow ${overflow}`);
  const head = await fetch(`${ctx.apiOrigin}/api/v1/assets/${forwardAsset.id}/content`, { method: "HEAD" });
  if (head.status !== 200) throw new Error(`episode HEAD ${head.status}`);
  ctx.state.episodeRender.forward = forwardAsset;
  ctx.state.episodeRender.reverse = reverseAsset;
  const pages = await verifyEpisodeCompositePages(ctx, forwardAsset.id);
  return { forward: forwardAsset.id, reverse: reverseAsset.id, playback, overflow, forwardOrder, reverseOrder, pages };
}

export async function episodeRenderReview(ctx) {
  const asset = ctx.state.episodeRender?.forward;
  if (!asset) throw new Error("episode playback asset is missing");
  const current = await assetRow(ctx, asset.id);
  ctx.expectStatus(await ctx.callApi(ctx.apiOrigin, "POST", `/assets/${asset.id}/review`, {
    ifMatch: Number(current.row_version) + 1,
    body: { decision: "APPROVE", note: "", contentHash: current.checksum_sha256 },
  }), 409, "REVISION_CONFLICT");
  ctx.expectStatus(await ctx.callApi(ctx.apiOrigin, "POST", `/assets/${asset.id}/review`, {
    ifMatch: current.row_version,
    body: { decision: "APPROVE", note: "", contentHash: "cd".repeat(32) },
  }), 409, "COMPOSE_CONTENT_HASH_MISMATCH");
  const key = "episode-review-once";
  const approved = ctx.expectStatus(await ctx.callApi(ctx.apiOrigin, "POST", `/assets/${asset.id}/review`, {
    key, ifMatch: current.row_version,
    body: { decision: "APPROVE", note: "episode cut", contentHash: current.checksum_sha256 },
  }), 200).body;
  const replay = ctx.expectStatus(await ctx.callApi(ctx.apiOrigin, "POST", `/assets/${asset.id}/review`, {
    key, ifMatch: current.row_version,
    body: { decision: "APPROVE", note: "episode cut", contentHash: current.checksum_sha256 },
  }), 200).body;
  if (replay.rowVersion !== approved.rowVersion) throw new Error("episode review replay changed the row");
  const events = await ctx.sql(
    `SELECT count(*)::int AS count FROM domain_event WHERE event_type = 'asset.reviewed' AND aggregate_id = $1`,
    [asset.id],
  );
  if (events[0].count !== 1) throw new Error(`episode review wrote ${events[0].count} events`);
  const rejected = await submitEpisode(ctx, [ctx.state.episodeRender.burned.assetId, ctx.state.episodeRender.plain.assetId]);
  const rejectedDone = await ctx.pollJob(rejected.jobId, 180_000);
  if (rejectedDone.state !== "SUCCEEDED") throw new Error(`episode reject source ${rejectedDone.state}`);
  const rejectedAsset = await episodeAsset(ctx, rejected.jobId);
  const returned = ctx.expectStatus(await ctx.callApi(ctx.apiOrigin, "POST", `/assets/${rejectedAsset.id}/review`, {
    ifMatch: Number(rejectedAsset.row_version),
    body: { decision: "REJECT", note: "return", contentHash: rejectedAsset.checksum_sha256 },
  }), 200).body;
  const raceAsset = await episodeAsset(ctx, (await submitAndWait(ctx, [ctx.state.episodeRender.plain.assetId, ctx.state.episodeRender.burned.assetId])).jobId);
  const left = ctx.callApi(ctx.apiOrigin, "POST", `/assets/${raceAsset.id}/review`, {
    ifMatch: Number(raceAsset.row_version),
    body: { decision: "APPROVE", note: "left", contentHash: raceAsset.checksum_sha256 },
  });
  const right = ctx.callApi(ctx.apiOrigin, "POST", `/assets/${raceAsset.id}/review`, {
    ifMatch: Number(raceAsset.row_version),
    body: { decision: "REJECT", note: "right", contentHash: raceAsset.checksum_sha256 },
  });
  const results = await Promise.all([left, right]);
  const statuses = results.map((item) => item.status).sort();
  if (statuses.join(",") !== "200,409" && statuses.join(",") !== "200,400") {
    throw new Error(`episode concurrent review ${statuses.join(",")}`);
  }
  const winnerEvents = await ctx.sql(
    `SELECT count(*)::int AS count FROM domain_event WHERE event_type = 'asset.reviewed' AND aggregate_id = $1`,
    [raceAsset.id],
  );
  if (winnerEvents[0].count !== 1) throw new Error(`episode race wrote ${winnerEvents[0].count} reviews`);
  ctx.state.episodeRender.approvedId = asset.id;
  return { approved: approved.reviewStatus, rejected: returned.reviewStatus, raceEvents: winnerEvents[0].count };
}

export async function episodeRenderLifecycle(ctx) {
  const canceled = await withHold(ctx, 8000, async () => {
    const submitted = await submitEpisode(ctx, [ctx.state.episodeRender.plain.assetId, ctx.state.episodeRender.burned.assetId]);
    await waitState(ctx, submitted.jobId, "RUNNING");
    ctx.expectStatus(await ctx.callApi(ctx.apiOrigin, "POST", `/generation-jobs/${submitted.jobId}/cancel`, { body: {} }), 200);
    const done = await ctx.pollJob(submitted.jobId, 60_000);
    const assets = await ctx.sql(`SELECT count(*)::int AS count FROM asset WHERE source_generation_job_id = $1`, [submitted.jobId]);
    if (done.state !== "CANCELED" || assets[0].count !== 0) throw new Error(`episode cancel-first ${done.state} assets ${assets[0].count}`);
    return { jobId: submitted.jobId };
  });
  const approved = ctx.state.episodeRender.approvedId;
  ctx.expectStatus(await ctx.callApi(ctx.apiOrigin, "POST", `/generation-jobs/${ctx.state.episodeRender.forward.job_id}/cancel`, { body: {} }), 409, "JOB_TERMINAL");
  const during = await withHold(ctx, 20000, async () => {
    const left = await shotComposite(ctx, await createSideShot(ctx), {}, true);
    const right = await shotComposite(ctx, await createSideShot(ctx), {}, true);
    const submitted = await submitEpisode(ctx, [left.assetId, right.assetId]);
    await waitState(ctx, submitted.jobId, "RUNNING");
    await replaceSideScene(ctx, left);
    const done = await ctx.pollJob(submitted.jobId, 120_000);
    const assets = await ctx.sql(`SELECT count(*)::int AS count FROM asset WHERE source_generation_job_id = $1`, [submitted.jobId]);
    if (done.state === "SUCCEEDED" || assets[0].count !== 0) throw new Error(`source changed during episode compose ${done.state}`);
    return { jobId: submitted.jobId, state: done.state };
  });
  const killed = await killRunningWorker(ctx);
  const locked = await lockAcrossLease(ctx);
  const injected = await injectCommitFailure(ctx);
  return { canceled, terminal: "JOB_TERMINAL", during, killed, locked, injected, approved };
}

export async function episodeRenderStale(ctx) {
  const assetId = ctx.state.episodeRender.approvedId;
  const before = await assetRow(ctx, assetId);
  if (before.review_status !== "APPROVED" || before.status !== "ACTIVE") throw new Error("episode composite was not approved");
  await replaceSideScene(ctx, ctx.state.episodeRender.burned);
  await waitForCurrentSources(ctx);
  const started = Date.now();
  let stale = before;
  while (Date.now() - started < 30_000) {
    stale = await assetRow(ctx, assetId);
    if (stale.status === "STALE") break;
    await ctx.sleep(500);
  }
  const source = await assetRow(ctx, ctx.state.episodeRender.burned.assetId);
  if (stale.status !== "STALE" || stale.review_status !== "APPROVED" || source.status !== "STALE" || source.review_status !== "APPROVED") {
    throw new Error(`episode stale chain ${stale.status} ${stale.review_status} source ${source.status} ${source.review_status}`);
  }
  const page = ctx.state.page;
  await page.goto(`${ctx.webOrigin}/projects/${ctx.state.world.projectId}?focus=episode-compose&episode=1`, { waitUntil: "domcontentloaded", timeout: 30_000 });
  const card = page.locator(`[data-composite-id="${assetId}"]`);
  const lookedUntil = Date.now() + 20_000;
  while ((await card.count()) === 0 && Date.now() < lookedUntil) {
    const more = page.getByRole("button", { name: "加载更早的成片" });
    if ((await more.count()) > 0) await more.click();
    await page.waitForTimeout(300);
  }
  await card.getByText("历史成片").waitFor({ timeout: 20_000 });
  const text = await card.innerText();
  if (!text.includes("APPROVED") || text.includes("当前成片")) throw new Error(`stale episode card ${text}`);
  return { assetId, status: stale.status, reviewStatus: stale.review_status, sourceStatus: source.status };
}

export async function episodeRenderIsolation(ctx) {
  const asset = await episodeAsset(ctx, ctx.state.episodeRender.forward.job_id);
  const other = (await episodes(ctx)).find((item) => item.episodeNo === 2);
  const foreign = await collectEpisodeComposites(ctx, other.id);
  if (foreign.ids.includes(asset.id)) throw new Error("episode list leaked into another episode");
  const own = await collectEpisodeComposites(ctx, ctx.state.episodeRender.episodeId);
  if (!own.ids.includes(asset.id)) throw new Error("episode list missed its own composite");
  if (new Set(own.ids).size !== own.ids.length || !own.ended) throw new Error("episode composite pages repeated or did not end");
  const edges = await ctx.sql(
    `SELECT source_asset_id::text AS source_asset_id FROM asset_dependency WHERE dependent_asset_id = $1 ORDER BY source_asset_id`,
    [asset.id],
  );
  const manifest = await ctx.sql(`SELECT metadata_json FROM asset WHERE id = $1`, [asset.id]);
  const segments = manifest[0].metadata_json.manifest.segments.map((segment) => segment.assetId).sort();
  const linked = edges.map((edge) => edge.source_asset_id).sort();
  if (segments.join() !== linked.join() || asset.source_shot_revision_id !== null) {
    throw new Error(`episode edges ${linked.join()} manifest ${segments.join()}`);
  }
  const costs = await ctx.sql(`SELECT count(*)::int AS count FROM cost_ledger WHERE generation_job_id = $1`, [asset.job_id]);
  if (costs[0].count !== 0) throw new Error("episode compose wrote a provider cost");
  const minio = await ctx.countMinio();
  if (minio !== ctx.state.evidence.minioBefore) throw new Error(`MinIO changed ${ctx.state.evidence.minioBefore} -> ${minio}`);
  if (!asset.object_key.startsWith(`compose/${ctx.workspaceId}/${ctx.state.world.projectId}/`)) {
    throw new Error(`episode object key ${asset.object_key}`);
  }
  return { assetId: asset.id, edges: linked.length, minio, objectKey: asset.object_key };
}

async function episodeWithoutMockDir(ctx) {
  await ctx.stopApp("worker");
  const env = ctx.childEnv({
    API_PORT: "3035",
    WORKER_HEALTH_PORT: "3036",
    M3_MOCK_IMAGE_ENABLED: "false",
    M3_MOCK_AV_ENABLED: "false",
    M3_MOCK_SUBTITLE_MUSIC_ENABLED: "false",
  }, ["MOCK_OBJECT_DIR"]);
  if (Object.hasOwn(env, "MOCK_OBJECT_DIR")) throw new Error("mock object dir was not removed");
  const names = ["api-episode-nomock", "worker-episode-nomock"];
  ctx.spawnApp(names[0], ["pnpm", "--filter", "@ai-drama/api", "start"], env);
  ctx.spawnApp(names[1], ["pnpm", "--filter", "@ai-drama/worker", "start"], env);
  try {
    await ctx.waitHttp("http://127.0.0.1:3035/api/v1/health/ready", (status, body) => status === 200 && body?.dependencies?.postgres?.status === "ok", 60_000);
    await ctx.waitHttp("http://127.0.0.1:3036/health/ready", (status, body) => status === 200 && body?.dependencies?.queue?.status === "ok", 60_000);
    const base = "http://127.0.0.1:3035";
    const pair = ctx.state.episodeRender;
    ctx.expectStatus(await ctx.callApi(base, "POST", `/shot-revisions/${pair.plain.revisionId}/compose`, {
      body: { videoAssetId: pair.plain.videoId, expectedInputHash: "ab".repeat(32) },
    }), 400, "CONFIGURATION_ERROR");
    const path = `/projects/${ctx.state.world.projectId}/episodes/${pair.episodeId}`;
    const preflight = ctx.expectStatus(await ctx.callApi(base, "POST", `${path}/compose-preflight`, {
      body: { compositeAssetIds: [pair.plain.assetId, pair.burned.assetId] },
    }), 200).body;
    const accepted = ctx.expectStatus(await ctx.callApi(base, "POST", `${path}/compose`, {
      body: { compositeAssetIds: [pair.plain.assetId, pair.burned.assetId], expectedInputHash: preflight.inputHash },
    }), 202).body;
    const done = await ctx.pollJob(accepted.jobId, 180_000);
    if (done.state !== "SUCCEEDED") throw new Error(`episode compose without mock dir ${done.state} ${done.errorCode ?? ""}`);
    const asset = await episodeAsset(ctx, accepted.jobId);
    const listed = ctx.expectStatus(await ctx.callApi(base, "GET", `${path}/composites?limit=10`), 200).body;
    if (listed.items?.[0]?.assetId !== asset.id) throw new Error("newest episode composite was not listed first without mock dir");
    const content = await fetch(`${base}/api/v1/assets/${asset.id}/content`);
    const bytes = Buffer.from(await content.arrayBuffer());
    if (content.status !== 200 || !String(content.headers.get("content-type")).includes("video/mp4") || bytes.subarray(4, 8).toString() !== "ftyp") {
      throw new Error(`episode content without mock dir ${content.status} ${bytes.length}`);
    }
    const reviewed = ctx.expectStatus(await ctx.callApi(base, "POST", `/assets/${asset.id}/review`, {
      ifMatch: Number(asset.row_version),
      body: { decision: "APPROVE", note: "without mock dir", contentHash: asset.checksum_sha256 },
    }), 200).body;
    if (reviewed.reviewStatus !== "APPROVED") throw new Error(`episode review without mock dir ${reviewed.reviewStatus}`);
    return { jobId: accepted.jobId, assetId: asset.id, bytes: bytes.length, reviewStatus: reviewed.reviewStatus };
  } finally {
    for (const name of names) await ctx.stopApp(name);
    if (!ctx.state.apps.some((item) => item.name === "worker")) await ctx.startWorker();
  }
}

async function verifyEpisodeCompositePages(ctx, reviewableId) {
  const seeded = await seedEpisodeCompositeTimestamps(ctx);
  const episodeId = ctx.state.episodeRender.episodeId;
  const expected = await exactEpisodeCompositeOrder(ctx, episodeId);
  const collected = await collectEpisodeComposites(ctx, episodeId, 1);
  if (!collected.ended || collected.ids.join() !== expected.map((item) => item.id).join()) {
    throw new Error("episode cursor skipped, repeated, or did not match database order");
  }
  for (const item of expected) {
    const seen = collected.createdAt.get(item.id);
    if (seen !== item.created_at_text || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(seen ?? "")) {
      throw new Error(`episode cursor lost timestamp precision for ${item.id}`);
    }
  }
  const sameInstant = expected.filter((item) => seeded.sameInstant.includes(item.id));
  if (sameInstant.length !== 2 || sameInstant[0].created_at_text !== sameInstant[1].created_at_text || !sameInstant[0].created_at_text.endsWith(".100001Z")) {
    throw new Error("same-timestamp episode composites were not both retained");
  }
  const page = ctx.state.page;
  await page.goto(`${ctx.webOrigin}/projects/${ctx.state.world.projectId}?focus=episode-compose&episode=1`, { waitUntil: "domcontentloaded", timeout: 30_000 });
  const card = page.locator(`[data-composite-id="${reviewableId}"]`);
  await card.getByRole("button", { name: "批准成片" }).waitFor({ timeout: 20_000 });
  const oldest = seeded.sameInstant[0];
  if ((await page.locator(`[data-composite-id="${oldest}"]`).count()) !== 0) throw new Error("history composite was already on the first page");
  await page.getByRole("button", { name: "加载更早的成片" }).click();
  await page.locator(`[data-composite-id="${oldest}"]`).waitFor({ timeout: 20_000 });
  await card.getByRole("button", { name: "批准成片" }).waitFor({ timeout: 10_000 });
  return { count: expected.length, microseconds: sameInstant[0].created_at_text, oldest };
}

async function collectEpisodeComposites(ctx, episodeId, limit = 10) {
  const ids = [];
  const createdAt = new Map();
  let cursor = "";
  let ended = false;
  for (let step = 0; step < 80; step += 1) {
    const suffix = cursor ? `&cursor=${encodeURIComponent(cursor)}` : "";
    const page = ctx.expectStatus(await ctx.callApi(
      ctx.apiOrigin, "GET", `/projects/${ctx.state.world.projectId}/episodes/${episodeId}/composites?limit=${limit}${suffix}`,
    ), 200).body;
    if ((page.items ?? []).length > limit) throw new Error("episode page exceeded its limit");
    for (const item of page.items ?? []) {
      if (ids.includes(item.assetId)) throw new Error(`episode page repeated ${item.assetId}`);
      ids.push(item.assetId);
      createdAt.set(item.assetId, item.createdAt);
    }
    if (!page.nextCursor) {
      ended = true;
      break;
    }
    if (page.nextCursor === cursor) throw new Error("episode cursor did not advance");
    cursor = page.nextCursor;
  }
  return { ids, createdAt, ended };
}

async function exactEpisodeCompositeOrder(ctx, episodeId) {
  return ctx.sql(
    `SELECT asset.id::text AS id,
            to_char(asset.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at_text
       FROM asset
      WHERE asset.workspace_id = $1
        AND asset.project_id = $2
        AND asset.kind = 'COMPOSITE'
        AND asset.storage_provider = 'local-compose'
        AND asset.source_kind = 'LOCAL_JOB'
        AND asset.source_shot_revision_id IS NULL
        AND asset.metadata_json->>'schema' = 'm4.episode.compose.asset.v1'
        AND asset.metadata_json->'manifest'->>'episodeId' = $3
      ORDER BY asset.created_at DESC, asset.id DESC`,
    [ctx.workspaceId, ctx.state.world.projectId, episodeId],
  );
}

async function seedEpisodeCompositeTimestamps(ctx) {
  const require = createRequire(join(ctx.repo, "packages/database/package.json"));
  const { Client } = require("pg");
  const client = new Client({ connectionString: ctx.databaseUrl, statement_timeout: 10_000 });
  await client.connect();
  try {
    await client.query("BEGIN");
    const template = (await client.query("SELECT * FROM asset WHERE id = $1", [ctx.state.episodeRender.forward.id])).rows[0];
    const job = (await client.query("SELECT * FROM generation_job WHERE id = $1", [template.source_generation_job_id])).rows[0];
    const run = (await client.query(
      `INSERT INTO workflow_run (workspace_id, project_id, type, requested_by, input_snapshot, status)
       VALUES ($1, $2, $3, 'cursor-fixture', $4, 'SUCCEEDED') RETURNING id`,
      [job.workspace_id, job.project_id, job.kind, job.input_snapshot],
    )).rows[0];
    const fixtureJob = (await client.query(
      `INSERT INTO generation_job
        (workspace_id, project_id, workflow_run_id, kind, state, input_hash, input_snapshot, source_shot_revision_id)
       VALUES ($1, $2, $3, $4, 'SUCCEEDED', $5, $6, NULL) RETURNING id`,
      [job.workspace_id, job.project_id, run.id, job.kind, job.input_hash, job.input_snapshot],
    )).rows[0];
    const attempt = (await client.query(
      `INSERT INTO job_attempt
        (workspace_id, generation_job_id, attempt_no, provider_client_request_key, request_snapshot, finished_at)
       VALUES ($1, $2, 1, $3, $4, clock_timestamp()) RETURNING id`,
      [job.workspace_id, fixtureJob.id, `cursor-fixture-${fixtureJob.id}`, job.input_snapshot],
    )).rows[0];
    const stamps = [
      "2020-01-01T00:00:00.100001Z",
      "2020-01-01T00:00:00.100001Z",
      "2020-01-01T00:00:00.100002Z",
    ];
    for (let index = 3; index < 12; index += 1) stamps.push(`2020-01-01T00:00:${String(index + 10).padStart(2, "0")}.000003Z`);
    const ids = [];
    for (let index = 0; index < stamps.length; index += 1) {
      const inserted = (await client.query(
        `INSERT INTO asset
          (workspace_id, project_id, kind, storage_provider, object_key, mime_type, byte_size, checksum_sha256,
           width, height, duration_ms, source_kind, source_job_attempt_id, source_generation_job_id, metadata_json, status, review_status, created_at)
         VALUES
          ($1, $2, 'COMPOSITE', 'local-compose', $3, 'video/mp4', $4, $5, $6, $7, $8, 'LOCAL_JOB', $9, $10, $11, 'ACTIVE', 'DRAFT', $12::timestamptz)
         RETURNING id::text AS id`,
        [
          template.workspace_id, template.project_id, `cursor-fixture/${fixtureJob.id}/${index}.mp4`,
          template.byte_size, template.checksum_sha256, template.width, template.height, template.duration_ms,
          attempt.id, fixtureJob.id, template.metadata_json, stamps[index],
        ],
      )).rows[0];
      ids.push(inserted.id);
    }
    await client.query("COMMIT");
    return { ids, sameInstant: ids.slice(0, 2) };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

async function approvedPair(ctx) {
  const plainShot = await createSideShot(ctx);
  const burnedShot = await createSideShot(ctx);
  const subtitle = ctx.expectStatus(await ctx.callApi(ctx.apiOrigin, "POST", `/shot-revisions/${burnedShot.revisionId}/generate-subtitle`, {
    body: { seed: "episode-order-subtitle" },
  }), 202).body;
  const subtitleDone = await ctx.pollJob(subtitle.jobId, 90_000);
  if (subtitleDone.state !== "SUCCEEDED") throw new Error(`episode subtitle ${subtitleDone.state}`);
  const subtitleAsset = (await ctx.jobLedger(subtitle.jobId)).assets[0];
  const plain = await shotComposite(ctx, plainShot, {}, true);
  const burned = await shotComposite(ctx, burnedShot, { subtitleAssetId: subtitleAsset.id }, true);
  const { episode } = await episodeRecord(ctx);
  const preflight = ctx.expectStatus(await ctx.callApi(ctx.apiOrigin, "POST", `/projects/${ctx.state.world.projectId}/episodes/${episode.id}/compose-preflight`, {
    body: { compositeAssetIds: [plain.assetId, burned.assetId] },
  }), 200).body;
  return { episodeId: episode.id, plain, burned, inputHash: preflight.inputHash };
}

async function shotComposite(ctx, shot, extra, approve) {
  const body = { videoAssetId: shot.videoId, ...extra };
  const preflight = ctx.expectStatus(await ctx.callApi(ctx.apiOrigin, "POST", `/shot-revisions/${shot.revisionId}/compose-preflight`, { body }), 200).body;
  const accepted = ctx.expectStatus(await ctx.callApi(ctx.apiOrigin, "POST", `/shot-revisions/${shot.revisionId}/compose`, {
    body: { ...body, expectedInputHash: preflight.inputHash },
  }), 202).body;
  const done = await ctx.pollJob(accepted.jobId, 180_000);
  if (done.state !== "SUCCEEDED") throw new Error(`shot composite ${done.state} ${done.errorCode ?? ""}`);
  const asset = (await ctx.sql(
    `SELECT id::text AS id, row_version, checksum_sha256, duration_ms, object_key FROM asset WHERE source_generation_job_id = $1`,
    [accepted.jobId],
  ))[0];
  if (!approve) return { ...shot, assetId: asset.id, jobId: accepted.jobId };
  ctx.expectStatus(await ctx.callApi(ctx.apiOrigin, "POST", `/assets/${asset.id}/review`, {
    ifMatch: Number(asset.row_version),
    body: { decision: "APPROVE", note: "episode source", contentHash: asset.checksum_sha256 },
  }), 200);
  return { ...shot, assetId: asset.id, durationMs: Number(asset.duration_ms), objectKey: asset.object_key, jobId: accepted.jobId };
}

async function submitEpisode(ctx, ids) {
  const preflight = ctx.expectStatus(await ctx.callApi(ctx.apiOrigin, "POST", `/projects/${ctx.state.world.projectId}/episodes/${ctx.state.episodeRender.episodeId}/compose-preflight`, {
    body: { compositeAssetIds: ids },
  }), 200).body;
  const accepted = ctx.expectStatus(await ctx.callApi(ctx.apiOrigin, "POST", `/projects/${ctx.state.world.projectId}/episodes/${ctx.state.episodeRender.episodeId}/compose`, {
    body: { compositeAssetIds: ids, expectedInputHash: preflight.inputHash },
  }), 202).body;
  return { jobId: accepted.jobId, inputHash: preflight.inputHash };
}

async function submitAndWait(ctx, ids) {
  const submitted = await submitEpisode(ctx, ids);
  const done = await ctx.pollJob(submitted.jobId, 180_000);
  if (done.state !== "SUCCEEDED") throw new Error(`episode wait ${done.state} ${done.errorCode ?? ""}`);
  return submitted;
}

async function episodeAsset(ctx, jobId) {
  const rows = await ctx.sql(
    `SELECT id::text AS id, source_generation_job_id::text AS job_id, source_shot_revision_id::text AS source_shot_revision_id,
            object_key, checksum_sha256, row_version, duration_ms, metadata_json
       FROM asset WHERE source_generation_job_id = $1`,
    [jobId],
  );
  if (!rows[0]) throw new Error(`episode asset missing for ${jobId}`);
  return rows[0];
}

async function assetRow(ctx, assetId) {
  return (await ctx.sql(
    `SELECT status, review_status, row_version, checksum_sha256 FROM asset WHERE id = $1`,
    [assetId],
  ))[0];
}

async function episodes(ctx) {
  return ctx.expectStatus(await ctx.callApi(ctx.apiOrigin, "GET", `/projects/${ctx.state.world.projectId}/episodes`), 200).body.items;
}

async function episodeRecord(ctx) {
  const items = await episodes(ctx);
  const episode = items.find((item) => item.episodeNo === 1);
  if (!episode) throw new Error("episode 1 is missing");
  return { episode };
}

async function frameOrder(ctx, asset, pair) {
  const file = join(ctx.composeObjectDir, asset.object_key);
  const early = await lightScore(file, "0.05");
  const later = await lightScore(file, "1.05");
  return { early, later, firstBrighter: early > later + 1, secondBrighter: later > early + 1, plain: pair.plain.assetId, burned: pair.burned.assetId };
}

async function lightScore(file, seconds) {
  const { stdout } = await execFileAsync("ffmpeg", [
    "-hide_banner", "-v", "error", "-ss", seconds, "-i", file, "-frames:v", "1",
    "-vf", "crop=400:120:340:1760", "-f", "rawvideo", "-pix_fmt", "rgb24", "-",
  ], { encoding: "buffer", maxBuffer: 2_000_000 });
  let total = 0;
  for (const value of stdout) total += value;
  return stdout.length === 0 ? 0 : total / stdout.length;
}

async function tableCounts(ctx) {
  const counts = {};
  for (const table of ["generation_job", "job_attempt", "workflow_run", "dispatch_outbox"]) {
    counts[table] = (await ctx.sql(`SELECT COUNT(*)::int AS count FROM ${table}`))[0].count;
  }
  return counts;
}

async function waitState(ctx, jobId, state) {
  const started = Date.now();
  while (Date.now() - started < 60_000) {
    const job = ctx.expectStatus(await ctx.callApi(ctx.apiOrigin, "GET", `/generation-jobs/${jobId}`), 200).body;
    if (job.state === state) return job;
    if (job.state === "SUCCEEDED" || job.state === "FAILED" || job.state === "CANCELED") {
      throw new Error(`episode job reached ${job.state} before ${state}`);
    }
    await ctx.sleep(300);
  }
  throw new Error(`episode job did not reach ${state}`);
}

async function withWorkerEnv(ctx, env, unset, run) {
  await ctx.stopApp("worker");
  ctx.spawnApp("worker", ["pnpm", "--filter", "@ai-drama/worker", "start"], ctx.childEnv(env, unset));
  await ctx.waitHttp(`${ctx.workerOrigin}/health/ready`, (status, body) => status === 200 && body?.dependencies?.queue?.status === "ok", 60_000);
  try {
    return await run();
  } finally {
    await ctx.stopApp("worker");
    await ctx.startWorker();
  }
}

async function withHold(ctx, holdMs, run) {
  return withWorkerEnv(ctx, { M4_COMPOSE_HOLD_BEFORE_COMMIT_MS: String(holdMs) }, [], run);
}

async function killRunningWorker(ctx) {
  const submitted = await submitEpisode(ctx, [ctx.state.episodeRender.plain.assetId, ctx.state.episodeRender.burned.assetId]);
  await waitState(ctx, submitted.jobId, "RUNNING");
  const watched = await waitForMediaTree();
  const app = ctx.state.apps.find((item) => item.name === "worker");
  if (!app?.pid) throw new Error("worker pid is missing");
  try { process.kill(process.platform === "linux" ? -app.pid : app.pid, "SIGKILL"); } catch { /* stop confirms it */ }
  await ctx.stopApp("worker");
  for (const pid of [watched.cli, ...watched.media]) {
    const started = Date.now();
    let alive = true;
    while (Date.now() - started < 15_000) {
      alive = await pidAlive(pid);
      if (!alive) break;
      await ctx.sleep(200);
    }
    if (alive) throw new Error(`episode media pid ${pid} survived the killed worker`);
  }
  try {
    await ctx.startWorker();
    const done = await ctx.pollJob(submitted.jobId, 180_000);
    const attempts = await ctx.sql(`SELECT id::text AS id FROM job_attempt WHERE generation_job_id = $1 ORDER BY attempt_no`, [submitted.jobId]);
    const assets = await ctx.sql(`SELECT source_job_attempt_id::text AS attempt_id FROM asset WHERE source_generation_job_id = $1`, [submitted.jobId]);
    if (done.state !== "SUCCEEDED" || attempts.length < 2 || assets.length !== 1 || assets[0].attempt_id !== attempts.at(-1).id) {
      throw new Error(`episode kill recovery ${done.state} ${JSON.stringify({ attempts, assets })}`);
    }
    return { boundary: KILL_BOUNDARY, jobId: submitted.jobId, attempts: attempts.length, assetAttempt: assets[0].attempt_id };
  } finally {
    if (!ctx.state.apps.some((item) => item.name === "worker")) await ctx.startWorker();
  }
}

async function lockAcrossLease(ctx) {
  return withWorkerEnv(ctx, { M4_COMPOSE_LEASE_MS: "4000" }, [], async () => {
    const submitted = await submitEpisode(ctx, [ctx.state.episodeRender.plain.assetId, ctx.state.episodeRender.burned.assetId]);
    await waitState(ctx, submitted.jobId, "RUNNING");
    const attempt = (await ctx.sql(
      `SELECT id::text AS id FROM job_attempt WHERE generation_job_id = $1 AND finished_at IS NULL ORDER BY attempt_no DESC LIMIT 1`,
      [submitted.jobId],
    ))[0];
    await holdJobLock(ctx, submitted.jobId, 8_000);
    const done = await ctx.pollJob(submitted.jobId, 180_000);
    const assets = await ctx.sql(`SELECT source_job_attempt_id::text AS attempt_id FROM asset WHERE source_generation_job_id = $1`, [submitted.jobId]);
    if (assets.some((row) => row.attempt_id === attempt.id)) throw new Error("expired episode attempt stored an asset");
    return { boundary: LOCK_BOUNDARY, jobId: submitted.jobId, state: done.state, expiredAttempt: attempt.id };
  });
}

async function injectCommitFailure(ctx) {
  return withWorkerEnv(ctx, { M4_COMPOSE_FAIL_INSIDE_COMMIT: "true" }, [], async () => {
    const submitted = await submitEpisode(ctx, [ctx.state.episodeRender.plain.assetId, ctx.state.episodeRender.burned.assetId]);
    const done = await ctx.pollJob(submitted.jobId, 180_000);
    const assets = await ctx.sql(`SELECT count(*)::int AS count FROM asset WHERE source_generation_job_id = $1`, [submitted.jobId]);
    const dependencies = await ctx.sql(
      `SELECT count(*)::int AS count FROM asset_dependency WHERE dependent_asset_id IN (SELECT id FROM asset WHERE source_generation_job_id = $1)`,
      [submitted.jobId],
    );
    const succeeded = await ctx.sql(
      `SELECT count(*)::int AS count FROM domain_event WHERE event_type = 'job.succeeded' AND aggregate_id = $1`,
      [submitted.jobId],
    );
    if (done.state !== "FAILED" || assets[0].count !== 0 || dependencies[0].count !== 0 || succeeded[0].count !== 0) {
      throw new Error(`episode injected commit ${done.state} assets ${assets[0].count} deps ${dependencies[0].count} events ${succeeded[0].count}`);
    }
    return { boundary: COMMIT_BOUNDARY, jobId: submitted.jobId, errorCode: done.errorCode };
  });
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
      throw new Error(`episode lock missed the live lease ${JSON.stringify(held.rows[0])}`);
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
    const cli = rows.find((row) => row.args.includes("media_worker.episode_compose"));
    if (cli) {
      const descendants = descendantPids(rows, cli.pid);
      const media = rows.filter((row) => descendants.includes(row.pid) && /\b(ffmpeg|ffprobe)\b/.test(row.args)).map((row) => row.pid);
      if (media.length > 0) return { cli: cli.pid, media };
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("episode renderer process tree was not visible");
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
