import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";

export const LEDGER_TABLES = ["generation_job", "job_attempt", "workflow_run", "asset", "cost_ledger", "dispatch_outbox", "domain_event"];

export function ledgerSnapshotQuery(table) {
  if (!LEDGER_TABLES.includes(table)) throw new Error(`unexpected ledger table ${table}`);
  return `SELECT id::text AS id, md5(row_to_json(t)::text) AS fingerprint FROM ${table} t ORDER BY id`;
}

export function summarizeLedgerTable(rows) {
  const ordered = [...rows].map((row) => ({
    id: String(row.id),
    fingerprint: String(row.fingerprint),
  })).sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  const fingerprint = createHash("sha256")
    .update(ordered.map((row) => `${row.id}:${row.fingerprint}`).join("\n"))
    .digest("hex");
  return { count: ordered.length, ids: ordered.map((row) => row.id), fingerprint };
}

export function ledgerChanges(before, after) {
  const changes = [];
  for (const table of LEDGER_TABLES) {
    const left = before?.[table];
    const right = after?.[table];
    if (!left || !right) {
      changes.push(`${table} missing`);
      continue;
    }
    if (left.count !== right.count) changes.push(`${table} count`);
    if (left.ids.join("\n") !== right.ids.join("\n")) changes.push(`${table} ids`);
    if (left.fingerprint !== right.fingerprint) changes.push(`${table} fingerprint`);
  }
  return changes;
}

export function ledgerPublicSummary(snapshot) {
  return LEDGER_TABLES.map((table) => ({
    table,
    count: snapshot[table].count,
    fingerprint: snapshot[table].fingerprint,
  }));
}

export async function composePreflightPage(ctx) {
  await waitForCurrentSources(ctx);
  await ensureWorker(ctx);
  const page = ctx.state.page;
  await page.goto(shotUrl(ctx), { waitUntil: "domcontentloaded", timeout: 30_000 });
  await page.getByRole("heading", { name: "Mock 单镜合成预检" }).waitFor({ timeout: 30_000 });
  const action = page.locator("#shot-action");
  await action.fill(ctx.draftMarker);
  if (await action.inputValue() !== ctx.draftMarker) throw new Error("shot draft was not retained before preflight");
  const videoId = await generateOnPage(ctx, "生成 Mock 视频", "已受理，结果以任务和视频列表为准。这不是生成成功。", "generate-video");
  const audioId = await generateOnPage(ctx, "生成 Mock 配音", "已受理，结果以任务和配音列表为准。这不是生成成功。", "generate-tts");
  const subtitleId = await generateOnPage(ctx, "生成 Mock 字幕", "已受理，结果以任务和字幕列表为准。这不是生成成功。", "generate-subtitle");
  const musicId = await generateOnPage(ctx, "生成 Mock 音乐", "已受理，结果以任务和音乐列表为准。这不是生成成功。", "generate-music");
  const panel = page.getByRole("region", { name: "Mock 单镜合成预检" });
  await panel.locator(`#compose-video option[value="${videoId}"]`).waitFor({ state: "attached", timeout: 30_000 });
  await panel.locator(`#compose-audio option[value="${audioId}"]`).waitFor({ state: "attached", timeout: 30_000 });
  await panel.locator(`#compose-subtitle option[value="${subtitleId}"]`).waitFor({ state: "attached", timeout: 30_000 });
  await panel.locator(`#compose-music option[value="${musicId}"]`).waitFor({ state: "attached", timeout: 30_000 });
  const options = await panel.locator("#compose-video").innerText();
  if (ctx.state.world.video?.assetId && options.includes(ctx.state.world.video.assetId)) {
    throw new Error("history video is listed as a current compose source");
  }
  await panel.locator("#compose-video").selectOption(videoId);
  await panel.locator("#compose-audio").selectOption(audioId);
  await panel.locator("#compose-music").selectOption(musicId);
  await panel.locator("#compose-subtitle").selectOption(subtitleId);
  const responsePromise = page.waitForResponse((response) =>
    response.url().includes(`/shot-revisions/${ctx.state.world.shotRevisionId}/compose-preflight`) && response.request().method() === "POST",
  { timeout: 20_000 });
  await panel.getByRole("button", { name: "预检合成输入" }).click();
  const response = await responsePromise;
  const payload = await response.json();
  if (response.status() !== 200 || response.headers()["cache-control"] !== "private, no-store") {
    throw new Error(`preflight response ${response.status()} ${response.headers()["cache-control"]}`);
  }
  if (response.request().headers()["idempotency-key"]) throw new Error("page preflight sent an idempotency key");
  assertManifest(payload, { videoId, audioId, musicId, subtitleId });
  await panel.getByText("合成尚未执行").waitFor({ timeout: 10_000 });
  const shown = await panel.innerText();
  if (!shown.includes("1080×1920") || !shown.includes("1000 ms") || !shown.includes(videoId) || !shown.includes(audioId)) {
    throw new Error(`preflight panel ${shown}`);
  }
  if (shown.includes("已受理") || shown.includes("生成成功")) throw new Error("preflight panel claims acceptance or success");
  await panel.getByText("预检摘要").click();
  if (!(await panel.innerText()).includes(payload.inputHash)) throw new Error("preflight hash is not shown");
  await panel.locator("#compose-music").selectOption("");
  await panel.getByText("合成尚未执行").waitFor({ state: "hidden", timeout: 10_000 });
  const cleared = await panel.innerText();
  if (cleared.includes(payload.inputHash)) throw new Error("changing the selection left the previous preflight hash");
  const rows = await ctx.sql(
    `SELECT id::text AS id, status, review_status FROM asset WHERE id = ANY($1::uuid[]) ORDER BY id`,
    [[videoId, audioId, musicId, subtitleId]],
  );
  if (rows.length !== 4 || rows.some((row) => row.status !== "ACTIVE" || row.review_status !== "DRAFT")) {
    throw new Error(`raw media was not left DRAFT ${JSON.stringify(rows)}`);
  }
  if (await action.inputValue() !== ctx.draftMarker) throw new Error("preflight overwrote the shot draft");
  ctx.state.world.compose = { videoId, audioId, musicId, subtitleId, inputHash: payload.inputHash };
  await page.screenshot({ path: join(ctx.outputDir, "compose-preflight-page.png"), fullPage: true });
  return { videoId, audioId, musicId, subtitleId, inputHash: payload.inputHash, review: rows };
}

export async function composePreflightGates(ctx) {
  const selected = ctx.state.world.compose;
  if (!selected?.videoId) throw new Error("compose page selection is missing");
  const revisionId = ctx.state.world.shotRevisionId;
  const full = {
    videoAssetId: selected.videoId,
    audioAssetId: selected.audioId,
    musicAssetId: selected.musicId,
    subtitleAssetId: selected.subtitleId,
  };
  const first = await postPreflight(ctx, ctx.apiOrigin, revisionId, full);
  const second = await postPreflight(ctx, ctx.apiOrigin, revisionId, {
    subtitleAssetId: selected.subtitleId,
    musicAssetId: selected.musicId,
    audioAssetId: selected.audioId,
    videoAssetId: selected.videoId,
  });
  ctx.expectStatus(first, 200);
  ctx.expectStatus(second, 200);
  if (first.cache !== "private, no-store" || first.body.inputHash !== selected.inputHash || second.body.inputHash !== first.body.inputHash) {
    throw new Error("normalized preflight hash was not stable");
  }
  const sparse = ctx.expectStatus(await postPreflight(ctx, ctx.apiOrigin, revisionId, { videoAssetId: selected.videoId }), 200);
  const explicitNull = ctx.expectStatus(await postPreflight(ctx, ctx.apiOrigin, revisionId, {
    videoAssetId: selected.videoId,
    audioAssetId: null,
    musicAssetId: null,
    subtitleAssetId: null,
  }), 200);
  if (sparse.body.inputHash !== explicitNull.body.inputHash) throw new Error("missing optional fields did not normalize to null");
  const secondAccepted = ctx.expectStatus(await ctx.callApi(ctx.apiOrigin, "POST", `/shot-revisions/${revisionId}/generate-video`, {
    body: { seed: "compose-preflight-second-video" },
  }), 202);
  const another = await ctx.pollJob(secondAccepted.body.jobId, 90_000);
  if (another.state !== "SUCCEEDED") throw new Error(`second video ${another.state}`);
  const secondLedger = await ctx.jobLedger(secondAccepted.body.jobId);
  const secondVideoId = secondLedger.assets[0]?.id;
  if (!secondVideoId || secondVideoId === selected.videoId) throw new Error("second video asset was not created");
  const changed = await postPreflight(ctx, ctx.apiOrigin, revisionId, { ...full, videoAssetId: secondVideoId });
  ctx.expectStatus(changed, 200);
  if (changed.body.inputHash === first.body.inputHash) throw new Error("replacing the video did not change the hash");
  const key = randomUUID();
  const replayLeft = await postPreflight(ctx, ctx.apiOrigin, revisionId, full, key);
  const replayRight = await postPreflight(ctx, ctx.apiOrigin, revisionId, { ...full, videoAssetId: secondVideoId }, key);
  if (replayLeft.body.inputHash !== first.body.inputHash || replayRight.body.inputHash !== changed.body.inputHash) {
    throw new Error("idempotency key replayed a preflight result");
  }
  const image = (await ctx.sql(
    `SELECT id::text AS id FROM asset
      WHERE workspace_id = $1 AND source_shot_revision_id = $2 AND kind = 'IMAGE' AND status = 'ACTIVE'
      ORDER BY created_at DESC LIMIT 1`,
    [ctx.workspaceId, revisionId],
  ))[0];
  if (!image) throw new Error("current image asset is missing");
  ctx.recordGate("compose-wrong-kind", "POST", "compose-preflight", ctx.expectStatus(
    await postPreflight(ctx, ctx.apiOrigin, revisionId, { videoAssetId: image.id }),
    400,
    "COMPOSE_INPUT_INVALID",
  ));
  ctx.expectStatus(await postPreflight(ctx, ctx.apiOrigin, revisionId, { ...full, objectKey: "mock/video.mp4" }), 400, "VALIDATION_ERROR");
  ctx.expectStatus(await postPreflight(ctx, ctx.apiOrigin, revisionId, { videoAssetId: selected.videoId, audioAssetId: selected.videoId }), 400, "VALIDATION_ERROR");
  const side = await createSideShot(ctx);
  ctx.expectStatus(await postPreflight(ctx, ctx.apiOrigin, revisionId, { videoAssetId: side.videoId }), 400, "COMPOSE_INPUT_INVALID");
  const oldRevision = (await ctx.sql(
    `SELECT id::text AS id FROM shot_revision WHERE shot_id = $1 AND id <> $2 ORDER BY created_at DESC LIMIT 1`,
    [ctx.state.world.shotId, revisionId],
  ))[0];
  if (!oldRevision) throw new Error("old shot revision is missing");
  ctx.expectStatus(await postPreflight(ctx, ctx.apiOrigin, oldRevision.id, full), 400, "REVIEW_REQUIRED");
  await replaceSideScene(ctx, side);
  await waitForCurrentSources(ctx);
  ctx.expectStatus(await postPreflight(ctx, ctx.apiOrigin, side.revisionId, { videoAssetId: side.videoId }), 400, "REVIEW_REQUIRED");
  ctx.expectStatus(await postPreflight(ctx, ctx.apiOrigin, revisionId, full), 200);
  const stopped = [];
  try {
    ctx.spawnApp("api-compose-other", ["pnpm", "--filter", "@ai-drama/api", "start"], ctx.appEnv({
      APP_WORKSPACE_ID: ctx.otherWorkspaceId,
      APP_WORKSPACE_NAME: "M4 compose other",
      API_PORT: "3018",
    }));
    ctx.spawnApp("api-compose-off", ["pnpm", "--filter", "@ai-drama/api", "start"], ctx.appEnv({
      API_PORT: "3019",
      M3_MOCK_AV_ENABLED: "false",
    }));
    ctx.spawnApp("api-compose-sm-off", ["pnpm", "--filter", "@ai-drama/api", "start"], ctx.appEnv({
      API_PORT: "3020",
      M3_MOCK_SUBTITLE_MUSIC_ENABLED: "false",
    }));
    ctx.spawnApp("api-compose-prod", ["pnpm", "--filter", "@ai-drama/api", "start"], ctx.appEnv({
      API_PORT: "3021",
      NODE_ENV: "production",
      M3_MOCK_AV_ENABLED: "true",
      M3_MOCK_SUBTITLE_MUSIC_ENABLED: "true",
      M3_MOCK_IMAGE_ENABLED: "true",
    }));
    const unsetEnv = ctx.childEnv({ API_PORT: "3022" }, ["M3_MOCK_AV_ENABLED"]);
    if (Object.hasOwn(unsetEnv, "M3_MOCK_AV_ENABLED")) throw new Error("unset did not remove M3_MOCK_AV_ENABLED");
    ctx.spawnApp("api-compose-unset", ["pnpm", "--filter", "@ai-drama/api", "start"], unsetEnv);
    stopped.push("api-compose-other", "api-compose-off", "api-compose-sm-off", "api-compose-prod", "api-compose-unset");
    for (const port of [3018, 3019, 3020, 3021, 3022]) {
      await ctx.waitHttp(`http://127.0.0.1:${port}/api/v1/health/ready`, (status, body) => status === 200 && body?.dependencies?.postgres?.status === "ok", 60_000);
    }
    ctx.expectStatus(await postPreflight(ctx, "http://127.0.0.1:3018", revisionId, full), 404, "NOT_FOUND");
    ctx.expectStatus(await postPreflight(ctx, "http://127.0.0.1:3019", revisionId, { videoAssetId: selected.videoId }), 400, "CONFIGURATION_ERROR");
    ctx.expectStatus(await postPreflight(ctx, "http://127.0.0.1:3020", revisionId, full), 400, "CONFIGURATION_ERROR");
    ctx.expectStatus(await postPreflight(ctx, "http://127.0.0.1:3021", revisionId, { videoAssetId: selected.videoId }), 400, "CONFIGURATION_ERROR");
    ctx.expectStatus(await postPreflight(ctx, "http://127.0.0.1:3022", revisionId, { videoAssetId: selected.videoId }), 400, "CONFIGURATION_ERROR");
  } finally {
    for (const name of stopped) await ctx.stopApp(name);
  }
  return {
    stableHash: first.body.inputHash,
    changedHash: changed.body.inputHash,
    secondVideoId,
    oldRevisionId: oldRevision.id,
    sideRevisionId: side.revisionId,
    standIn: "REJECTED, non-ACTIVE, and bad metadata are covered by constructed rows in the domain unit tests, not by live rows.",
  };
}

export async function composePreflightReadonly(ctx) {
  const selected = ctx.state.world.compose;
  const revisionId = ctx.state.world.shotRevisionId;
  const before = await ledgerSnapshot(ctx);
  const body = {
    videoAssetId: selected.videoId,
    audioAssetId: selected.audioId,
    musicAssetId: selected.musicId,
    subtitleAssetId: selected.subtitleId,
  };
  ctx.expectStatus(await postPreflight(ctx, ctx.apiOrigin, revisionId, body), 200);
  ctx.expectStatus(await postPreflight(ctx, ctx.apiOrigin, revisionId, body), 200);
  ctx.expectStatus(await postPreflight(ctx, ctx.apiOrigin, revisionId, { videoAssetId: selected.videoId, path: "/tmp/video.mp4" }), 400, "VALIDATION_ERROR");
  const image = (await ctx.sql(
    `SELECT id::text AS id FROM asset
      WHERE workspace_id = $1 AND source_shot_revision_id = $2 AND kind = 'IMAGE' AND status = 'ACTIVE'
      LIMIT 1`,
    [ctx.workspaceId, revisionId],
  ))[0];
  if (!image) throw new Error("current image asset is missing");
  ctx.expectStatus(await postPreflight(ctx, ctx.apiOrigin, revisionId, { videoAssetId: image.id }), 400, "COMPOSE_INPUT_INVALID");
  const panel = ctx.state.page.getByRole("region", { name: "Mock 单镜合成预检" });
  await panel.locator("#compose-music").selectOption(selected.musicId);
  await panel.getByRole("button", { name: "预检合成输入" }).click();
  await panel.getByText("合成尚未执行").waitFor({ timeout: 20_000 });
  const after = await ledgerSnapshot(ctx);
  const changes = ledgerChanges(before, after);
  if (changes.length > 0) {
    throw new Error(`preflight changed stored records: ${changes.join(", ")}`);
  }
  const page = ctx.state.page;
  if (await page.locator("#shot-action").inputValue() !== ctx.draftMarker) {
    throw new Error("shot draft changed before the 390px check");
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("region", { name: "Mock 单镜合成预检" }).getByText("预检摘要").click();
  const overflow = await page.evaluate(() => ({
    documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    bodyOverflow: document.body.scrollWidth - document.body.clientWidth,
  }));
  if (overflow.documentOverflow > 1 || overflow.bodyOverflow > 1) throw new Error(`390px overflow ${JSON.stringify(overflow)}`);
  await page.screenshot({ path: join(ctx.outputDir, "compose-preflight-390.png"), fullPage: true });
  await page.setViewportSize({ width: 1280, height: 900 });
  if (await page.locator("#shot-action").inputValue() !== ctx.draftMarker) throw new Error("390px check overwrote the shot draft");
  return { unchanged: ledgerPublicSummary(before), overflow };
}

async function generateOnPage(ctx, buttonName, notice, urlPart) {
  const before = ctx.state.posts.length;
  await ctx.state.page.getByRole("button", { name: buttonName, exact: true }).click({ timeout: 30_000 });
  await ctx.state.page.getByText(notice).waitFor({ timeout: 20_000 });
  const post = [...ctx.state.posts].slice(before).reverse().find((item) => item.url.includes(urlPart));
  if (!post || post.status !== 202) throw new Error(`${urlPart} was not accepted`);
  const job = await ctx.pollJob(post.body.jobId, 90_000);
  if (job.state !== "SUCCEEDED") throw new Error(`${urlPart} ${job.state} ${job.errorCode ?? ""}`);
  const ledger = await ctx.jobLedger(post.body.jobId);
  const assetId = ledger.assets[0]?.id;
  if (!assetId || ledger.assets[0].review_status !== "DRAFT" || ledger.assets[0].source_shot_revision_id !== ctx.state.world.shotRevisionId) {
    throw new Error(`${urlPart} asset ${JSON.stringify(ledger.assets[0])}`);
  }
  return assetId;
}

export async function createSideShot(ctx) {
  const episode = ctx.expectStatus(await ctx.callApi(ctx.apiOrigin, "GET", `/projects/${ctx.state.world.projectId}/episodes`), 200)
    .body.items.find((item) => item.episodeNo === 1);
  const nextOrdinal = Number((await ctx.sql(
    `SELECT COALESCE(MAX(revision.ordinal), 0) + 1 AS ordinal
       FROM scene
       JOIN scene_revision AS revision ON revision.id = scene.current_revision_id
      WHERE scene.workspace_id = $1 AND scene.episode_id = $2`,
    [ctx.workspaceId, episode.id],
  ))[0].ordinal);
  if (!Number.isInteger(nextOrdinal) || nextOrdinal < 2) throw new Error(`side scene ordinal ${nextOrdinal}`);
  const scene = ctx.expectStatus(await ctx.callApi(
    ctx.apiOrigin,
    "POST",
    `/projects/${ctx.state.world.projectId}/episodes/${episode.id}/scenes`,
    {
      ifMatch: episode.rowVersion,
      body: {
        sourceScriptRevisionId: ctx.state.world.scriptRevisionId,
        ordinal: nextOrdinal,
        heading: `INT. OTHER ${nextOrdinal}`,
        summary: "A separate room for compose gate checks",
      },
    },
  ), 201);
  await ctx.approve(
    ctx.apiOrigin,
    `/projects/${ctx.state.world.projectId}/episodes/${episode.id}/scenes/${scene.body.entityId}/revisions/${scene.body.revisionId}/review`,
    scene.body.rowVersion,
  );
  const sceneVersion = ctx.expectStatus(await ctx.callApi(
    ctx.apiOrigin,
    "GET",
    `/projects/${ctx.state.world.projectId}/episodes/${episode.id}/scenes/${scene.body.entityId}/revisions`,
  ), 200).body.aggregate.rowVersion;
  const shot = ctx.expectStatus(await ctx.callApi(
    ctx.apiOrigin,
    "POST",
    `/projects/${ctx.state.world.projectId}/episodes/${episode.id}/scenes/${scene.body.entityId}/shots`,
    { ifMatch: sceneVersion, body: ctx.shotPayload(scene.body.revisionId, 1, "compose-side-shot", ctx.promptText, ctx.dialogueText) },
  ), 201);
  await ctx.approve(
    ctx.apiOrigin,
    `/projects/${ctx.state.world.projectId}/episodes/${episode.id}/scenes/${scene.body.entityId}/shots/${shot.body.entityId}/revisions/${shot.body.revisionId}/review`,
    shot.body.rowVersion,
  );
  const accepted = ctx.expectStatus(await ctx.callApi(ctx.apiOrigin, "POST", `/shot-revisions/${shot.body.revisionId}/generate-video`, {
    body: { seed: "compose-side-video" },
  }), 202);
  const done = await ctx.pollJob(accepted.body.jobId, 90_000);
  if (done.state !== "SUCCEEDED") throw new Error(`side video ${done.state}`);
  const ledger = await ctx.jobLedger(accepted.body.jobId);
  return { sceneId: scene.body.entityId, revisionId: shot.body.revisionId, videoId: ledger.assets[0].id };
}

export async function replaceSideScene(ctx, side) {
  const episode = ctx.expectStatus(await ctx.callApi(ctx.apiOrigin, "GET", `/projects/${ctx.state.world.projectId}/episodes`), 200)
    .body.items.find((item) => item.episodeNo === 1);
  const history = ctx.expectStatus(await ctx.callApi(
    ctx.apiOrigin,
    "GET",
    `/projects/${ctx.state.world.projectId}/episodes/${episode.id}/scenes/${side.sceneId}/revisions`,
  ), 200).body;
  const current = history.items.find((item) => item.id === history.aggregate.currentRevisionId);
  if (!current) throw new Error("side scene has no current revision");
  const created = ctx.expectStatus(await ctx.callApi(
    ctx.apiOrigin,
    "POST",
    `/projects/${ctx.state.world.projectId}/episodes/${episode.id}/scenes/${side.sceneId}/revisions`,
    {
      ifMatch: history.aggregate.rowVersion,
      body: {
        sourceScriptRevisionId: ctx.state.world.scriptRevisionId,
        ordinal: current.ordinal,
        heading: "INT. OTHER LATER",
        summary: "Replaced source for the side shot",
      },
    },
  ), 201);
  await ctx.approve(
    ctx.apiOrigin,
    `/projects/${ctx.state.world.projectId}/episodes/${episode.id}/scenes/${side.sceneId}/revisions/${created.body.revisionId}/review`,
    created.body.rowVersion,
  );
}

async function postPreflight(ctx, base, revisionId, body, key = randomUUID()) {
  const response = await fetch(`${base}/api/v1/shot-revisions/${revisionId}/compose-preflight`, {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": key },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await response.text();
  let parsed = null;
  if (text.length > 0) {
    try { parsed = JSON.parse(text); } catch { parsed = { raw: text.slice(0, 400) }; }
  }
  return { status: response.status, body: parsed, cache: response.headers.get("cache-control") };
}

function assertManifest(payload, ids) {
  if (payload?.schema !== "m4.shot.compose.preflight.v1" || !/^[0-9a-f]{64}$/.test(payload.inputHash ?? "")) {
    throw new Error(`preflight payload ${JSON.stringify(payload)}`);
  }
  const plan = payload.manifest?.plan;
  if (plan?.width !== 1080 || plan?.height !== 1920 || plan?.frameRate !== 25 || plan?.container !== "mp4" || plan?.durationMs !== 1000) {
    throw new Error(`preflight plan ${JSON.stringify(plan)}`);
  }
  const sources = payload.manifest?.sources ?? [];
  if (sources.map((slot) => slot.asset?.assetId ?? null).join() !== [ids.videoId, ids.audioId, ids.musicId, ids.subtitleId].join()) {
    throw new Error(`preflight sources ${JSON.stringify(sources)}`);
  }
  if (JSON.stringify(payload.manifest).includes("rowVersion")) throw new Error("manifest includes rowVersion");
}

async function ledgerSnapshot(ctx) {
  const snapshot = {};
  for (const table of LEDGER_TABLES) {
    snapshot[table] = summarizeLedgerTable(await ctx.sql(ledgerSnapshotQuery(table)));
  }
  return snapshot;
}

export async function waitForCurrentSources(ctx) {
  const started = Date.now();
  let pending = [{ count: 1 }];
  while (Date.now() - started < 30_000) {
    pending = await ctx.sql(
      "SELECT count(*)::int AS count FROM stale_recalculation WHERE project_id = $1 AND status IN ('PENDING', 'RUNNING')",
      [ctx.state.world.projectId],
    );
    if (pending[0].count === 0) return;
    await ctx.sleep(500);
  }
  throw new Error("stale recalculation did not finish before compose preflight");
}

async function ensureWorker(ctx) {
  try {
    const response = await fetch(`${ctx.workerOrigin}/health/ready`, { signal: AbortSignal.timeout(2000) });
    if (response.status === 200) return;
    throw new Error(`worker ready ${response.status}`);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("worker ready")) throw error;
    await ctx.startWorker();
  }
}

function shotUrl(ctx) {
  return `${ctx.webOrigin}/projects/${ctx.state.world.projectId}?focus=shot&episode=1&scene=${ctx.state.world.sceneId}&shot=${ctx.state.world.shotId}`;
}
