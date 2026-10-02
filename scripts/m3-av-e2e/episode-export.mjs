import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { summarizeLedgerTable } from "./compose-preflight.mjs";
import { createSideShot, replaceSideScene, waitForCurrentSources } from "./compose-preflight.mjs";
import { EPISODE_FINGERPRINT_TABLES, episodeFingerprintChanges, episodeFingerprintQuery } from "./episode-compose-preflight.mjs";

const execFileAsync = promisify(execFile);

export async function episodeExportDownload(ctx) {
  const first = await createSideShot(ctx);
  const second = await createSideShot(ctx);
  const plain = await approveShotComposite(ctx, first);
  const burned = await approveShotComposite(ctx, second);
  const episode = await episodeOne(ctx);
  const asset = await renderEpisode(ctx, episode.id, [plain.assetId, burned.assetId], true);
  ctx.state.episodeExport = {
    episodeId: episode.id,
    episodeNo: episode.episodeNo,
    assetId: asset.id,
    checksum: asset.checksum_sha256,
    byteSize: Number(asset.byte_size),
    jobId: asset.jobId,
    attemptId: asset.attempt_id,
    inputHash: asset.inputHash,
    shots: [first, second],
    plain,
    burned,
  };
  const page = ctx.state.page;
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${ctx.webOrigin}/projects/${ctx.state.world.projectId}?focus=episode-compose&episode=1`, { waitUntil: "domcontentloaded", timeout: 30_000 });
  const card = page.locator(`[data-composite-id="${asset.id}"]`);
  await card.getByRole("button", { name: "下载 MP4" }).waitFor({ timeout: 20_000 });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  await page.screenshot({ path: join(ctx.outputDir, "episode-export-390.png"), fullPage: true });
  if (overflow > 1) throw new Error(`episode export overflow ${overflow}`);
  const mp4Path = join(ctx.outputDir, "episode-export.mp4");
  const jsonPath = join(ctx.outputDir, "episode-export.json");
  await saveDownload(page, card.getByRole("button", { name: "下载 MP4" }), mp4Path);
  await saveDownload(page, card.getByRole("button", { name: "下载来源清单" }), jsonPath);
  await page.setViewportSize({ width: 1280, height: 900 });
  const mp4 = await readFile(mp4Path);
  const manifestText = await readFile(jsonPath, "utf8");
  const manifest = JSON.parse(manifestText);
  const sha256 = createHash("sha256").update(mp4).digest("hex");
  if (sha256 !== asset.checksum_sha256 || mp4.length !== Number(asset.byte_size)) {
    throw new Error(`downloaded mp4 ${sha256} ${mp4.length} record ${asset.checksum_sha256} ${asset.byte_size}`);
  }
  if (manifest.schema !== "m4.episode.export.manifest.v1" || manifest.asset.checksumSha256 !== sha256 || manifest.asset.byteSize !== mp4.length) {
    throw new Error("export manifest does not match the downloaded mp4");
  }
  if (manifest.compose.jobId !== asset.jobId || manifest.compose.inputHash !== asset.inputHash || manifest.compose.preflightInputHash == null) {
    throw new Error("export manifest does not match the frozen compose job");
  }
  await assertManifestMatchesDatabase(ctx, asset.id, manifest);
  await probeMp4(mp4Path, mp4.length);
  const downloadPath = exportPath(ctx, asset.id, asset.checksum_sha256);
  const head = await fetch(`${ctx.apiOrigin}/api/v1${downloadPath}`, { method: "HEAD" });
  const headBody = Buffer.from(await head.arrayBuffer());
  if (head.status !== 200 || headBody.length !== 0 || head.headers.get("content-length") !== String(mp4.length) || head.headers.get("content-type") !== "video/mp4") {
    throw new Error(`episode export HEAD ${head.status} ${headBody.length} ${head.headers.get("content-length")}`);
  }
  const ranged = await fetch(`${ctx.apiOrigin}/api/v1${downloadPath}`, { headers: { range: "bytes=0-8" } });
  const rangedBody = Buffer.from(await ranged.arrayBuffer());
  if (ranged.status !== 200 || rangedBody.length !== mp4.length || !rangedBody.equals(mp4)) {
    throw new Error(`episode export range ${ranged.status} ${rangedBody.length}`);
  }
  const webHead = await fetch(`${ctx.webOrigin}/api/v1${downloadPath}`, { method: "HEAD" });
  if (webHead.status !== 200 || (await webHead.arrayBuffer()).byteLength !== 0 || !webHead.headers.get("content-disposition")?.includes("attachment")) {
    throw new Error(`episode export web HEAD ${webHead.status}`);
  }
  return {
    assetId: asset.id,
    jobId: asset.jobId,
    attemptId: asset.attempt_id,
    byteSize: mp4.length,
    sha256,
    manifestSha256: createHash("sha256").update(manifestText).digest("hex"),
    overflow,
  };
}

export async function episodeExportGates(ctx) {
  const saved = ctx.state.episodeExport;
  if (!saved) throw new Error("episode export asset was not prepared");
  const projectId = ctx.state.world.projectId;
  const path = exportPath(ctx, saved.assetId, saved.checksum);
  ctx.expectStatus(await ctx.callApi(ctx.apiOrigin, "GET", exportPath(ctx, saved.assetId, "cd".repeat(32))), 409, "COMPOSE_CONTENT_HASH_MISMATCH");
  ctx.expectStatus(await ctx.callApi(ctx.apiOrigin, "GET", exportPath(ctx, saved.plain.assetId, saved.checksum)), 400, "COMPOSE_INPUT_INVALID");
  const otherEpisode = (await ctx.callApi(ctx.apiOrigin, "GET", `/projects/${projectId}/episodes`)).body.items.find((item) => item.episodeNo === 2);
  ctx.expectStatus(await ctx.callApi(ctx.apiOrigin, "GET", `/projects/${projectId}/episodes/${otherEpisode.id}/composites/${saved.assetId}/download?expectedContentHash=${saved.checksum}`), 400, "COMPOSE_INPUT_INVALID");
  ctx.expectStatus(await ctx.callApi(ctx.apiOrigin, "GET", `/projects/12121212-1212-4212-8212-121212121212/episodes/${saved.episodeId}/composites/${saved.assetId}/download?expectedContentHash=${saved.checksum}`), 404, "NOT_FOUND");
  const staleId = ctx.state.episodeRender?.approvedId;
  if (!staleId) throw new Error("stale episode composite was not prepared");
  const stale = (await ctx.sql("SELECT checksum_sha256, status FROM asset WHERE id = $1", [staleId]))[0];
  if (stale.status !== "STALE") throw new Error(`expected a stale episode composite, got ${stale.status}`);
  ctx.expectStatus(await ctx.callApi(ctx.apiOrigin, "GET", exportPath(ctx, staleId, stale.checksum_sha256)), 400, "COMPOSE_INPUT_INVALID");
  const draft = await renderEpisode(ctx, saved.episodeId, [saved.plain.assetId, saved.burned.assetId], false);
  ctx.expectStatus(await ctx.callApi(ctx.apiOrigin, "GET", exportPath(ctx, draft.id, draft.checksum_sha256)), 400, "COMPOSE_INPUT_INVALID");
  ctx.expectStatus(await ctx.callApi(ctx.apiOrigin, "POST", `/assets/${draft.id}/review`, {
    ifMatch: Number(draft.row_version),
    body: { decision: "REJECT", note: "export gate", contentHash: draft.checksum_sha256 },
  }), 200);
  const rejected = (await ctx.sql("SELECT review_status, checksum_sha256 FROM asset WHERE id = $1", [draft.id]))[0];
  if (rejected.review_status !== "REJECTED") throw new Error(`episode export draft was not rejected ${rejected.review_status}`);
  ctx.expectStatus(await ctx.callApi(ctx.apiOrigin, "GET", exportPath(ctx, draft.id, rejected.checksum_sha256)), 400, "COMPOSE_INPUT_INVALID");
  const names = [];
  try {
    ctx.spawnApp("api-export-off", ["pnpm", "--filter", "@ai-drama/api", "start"], ctx.appEnv({ API_PORT: "3043", M4_LOCAL_EPISODE_COMPOSE_ENABLED: "false" }));
    ctx.spawnApp("api-export-prod", ["pnpm", "--filter", "@ai-drama/api", "start"], ctx.appEnv({ API_PORT: "3044", NODE_ENV: "production", M4_LOCAL_EPISODE_COMPOSE_ENABLED: "true" }));
    const unsetEnv = ctx.childEnv({ API_PORT: "3045" }, ["M4_LOCAL_EPISODE_COMPOSE_ENABLED"]);
    ctx.spawnApp("api-export-unset", ["pnpm", "--filter", "@ai-drama/api", "start"], unsetEnv);
    ctx.spawnApp("api-export-other", ["pnpm", "--filter", "@ai-drama/api", "start"], ctx.appEnv({
      API_PORT: "3046",
      APP_WORKSPACE_ID: ctx.otherWorkspaceId,
      APP_WORKSPACE_NAME: "M4 episode export other",
    }));
    const noMock = ctx.childEnv({
      API_PORT: "3042",
      M3_MOCK_IMAGE_ENABLED: "false",
      M3_MOCK_AV_ENABLED: "false",
      M3_MOCK_SUBTITLE_MUSIC_ENABLED: "false",
    }, ["MOCK_OBJECT_DIR"]);
    if (Object.hasOwn(noMock, "MOCK_OBJECT_DIR") || Object.hasOwn(noMock, "M4_EPISODE_EXPORT_ENABLED")) {
      throw new Error("export gate env was not limited to the existing compose switches");
    }
    ctx.spawnApp("api-export-nomock", ["pnpm", "--filter", "@ai-drama/api", "start"], noMock);
    names.push("api-export-off", "api-export-prod", "api-export-unset", "api-export-other", "api-export-nomock");
    for (const port of [3042, 3043, 3044, 3045, 3046]) {
      await ctx.waitHttp(`http://127.0.0.1:${port}/api/v1/health/ready`, (status, body) => status === 200 && body?.dependencies?.postgres?.status === "ok", 60_000);
    }
    for (const base of ["http://127.0.0.1:3043", "http://127.0.0.1:3044", "http://127.0.0.1:3045"]) {
      ctx.expectStatus(await ctx.callApi(base, "GET", path), 400, "CONFIGURATION_ERROR");
    }
    ctx.expectStatus(await ctx.callApi("http://127.0.0.1:3046", "GET", path), 404, "NOT_FOUND");
    const nomock = await fetch(`http://127.0.0.1:3042/api/v1${path}`);
    const nomockBody = Buffer.from(await nomock.arrayBuffer());
    if (nomock.status !== 200 || createHash("sha256").update(nomockBody).digest("hex") !== saved.checksum) {
      throw new Error(`export without mock object dir failed ${nomock.status} ${nomockBody.length}`);
    }
  } finally {
    for (const name of names) await ctx.stopApp(name);
  }
  await withPendingStale(ctx, async () => {
    ctx.expectStatus(await ctx.callApi(ctx.apiOrigin, "GET", path), 400, "STALE_RECALCULATION_PENDING");
  });
  const recovered = await fetch(`${ctx.apiOrigin}/api/v1${path}`);
  if (recovered.status !== 200) throw new Error(`export stayed blocked after stale propagation ${recovered.status}`);
  await recovered.arrayBuffer();
  const latched = await latchRefusal(ctx);
  return { draftId: draft.id, staleId, latched };
}

export async function episodeExportReadonly(ctx) {
  const saved = ctx.state.episodeExport;
  if (!saved) throw new Error("episode export asset was not prepared");
  await waitExportIdle(ctx);
  const before = await exportSnapshot(ctx);
  const path = exportPath(ctx, saved.assetId, saved.checksum);
  const first = await fetch(`${ctx.apiOrigin}/api/v1${path}`);
  const firstBody = Buffer.from(await first.arrayBuffer());
  const second = await fetch(`${ctx.apiOrigin}/api/v1${path}`);
  const secondBody = Buffer.from(await second.arrayBuffer());
  const head = await fetch(`${ctx.apiOrigin}/api/v1${path}`, { method: "HEAD" });
  const headBody = Buffer.from(await head.arrayBuffer());
  const manifest = await fetch(`${ctx.apiOrigin}/api/v1${path.replace("/download?", "/export-manifest?")}`);
  const manifestBody = Buffer.from(await manifest.arrayBuffer());
  if (first.status !== 200 || second.status !== 200 || head.status !== 200 || headBody.length !== 0 || manifest.status !== 200) {
    throw new Error(`readonly export responses ${first.status} ${second.status} ${head.status} ${manifest.status}`);
  }
  if (!firstBody.equals(secondBody) || createHash("sha256").update(firstBody).digest("hex") !== saved.checksum) {
    throw new Error("repeated export bytes changed");
  }
  if (!manifestBody.includes(saved.checksum)) throw new Error("readonly manifest missed the asset checksum");
  ctx.expectStatus(await ctx.callApi(ctx.apiOrigin, "GET", exportPath(ctx, saved.assetId, "cd".repeat(32))), 409, "COMPOSE_CONTENT_HASH_MISMATCH");
  const after = await exportSnapshot(ctx);
  const changes = episodeFingerprintChanges(before, after);
  if (changes.length > 0) throw new Error(`episode export changed stored records: ${changes.join(", ")}`);
  return {
    unchanged: EPISODE_FINGERPRINT_TABLES.map((table) => ({ table, count: before[table].count, fingerprint: before[table].fingerprint })),
  };
}

async function latchRefusal(ctx) {
  const left = await createSideShot(ctx);
  const right = await createSideShot(ctx);
  const first = await approveShotComposite(ctx, left);
  const second = await approveShotComposite(ctx, right);
  const episodeId = ctx.state.episodeExport.episodeId;
  const asset = await renderEpisode(ctx, episodeId, [first.assetId, second.assetId], true);
  const latchDir = join(ctx.outputDir, "episode-export-latch");
  await mkdir(latchDir, { recursive: true });
  const env = ctx.appEnv({ API_PORT: "3041", M4_EPISODE_EXPORT_LATCH_DIR: latchDir });
  ctx.spawnApp("api-export-latch", ["pnpm", "--filter", "@ai-drama/api", "start"], env);
  try {
    await ctx.waitHttp("http://127.0.0.1:3041/api/v1/health/ready", (status, body) => status === 200 && body?.dependencies?.postgres?.status === "ok", 60_000);
    const responsePromise = fetch(`http://127.0.0.1:3041/api/v1${exportPath(ctx, asset.id, asset.checksum_sha256)}`, { signal: AbortSignal.timeout(50_000) });
    const readyAt = Date.now();
    while (Date.now() - readyAt < 20_000) {
      try {
        const info = await lstat(join(latchDir, "ready"));
        if (info.isFile()) break;
      } catch {
        await ctx.sleep(50);
      }
    }
    const ready = await lstat(join(latchDir, "ready")).catch(() => null);
    if (!ready?.isFile()) throw new Error("episode export latch did not open");
    await replaceSideScene(ctx, left);
    await waitForCurrentSources(ctx);
    await writeFile(join(latchDir, "release"), "");
    const response = await responsePromise;
    const text = await response.text();
    const body = text.length === 0 ? null : JSON.parse(text);
    if (response.status === 200 || response.headers.get("content-disposition")) {
      throw new Error(`latch export was sent ${response.status}`);
    }
    if (!body?.error?.code) throw new Error(`latch export ${response.status} ${text.slice(0, 200)}`);
    return { assetId: asset.id, status: response.status, code: body.error.code };
  } finally {
    await ctx.stopApp("api-export-latch");
  }
}

async function saveDownload(page, button, target) {
  const [download] = await Promise.all([
    page.waitForEvent("download", { timeout: 30_000 }),
    button.click(),
  ]);
  await download.saveAs(target);
}

async function approveShotComposite(ctx, shot) {
  const preflight = ctx.expectStatus(await ctx.callApi(ctx.apiOrigin, "POST", `/shot-revisions/${shot.revisionId}/compose-preflight`, {
    body: { videoAssetId: shot.videoId },
  }), 200).body;
  const accepted = ctx.expectStatus(await ctx.callApi(ctx.apiOrigin, "POST", `/shot-revisions/${shot.revisionId}/compose`, {
    body: { videoAssetId: shot.videoId, expectedInputHash: preflight.inputHash },
  }), 202).body;
  const done = await ctx.pollJob(accepted.jobId, 180_000);
  if (done.state !== "SUCCEEDED") throw new Error(`export shot composite ${done.state} ${done.errorCode ?? ""}`);
  const asset = (await ctx.sql(
    "SELECT id::text AS id, row_version, checksum_sha256 FROM asset WHERE source_generation_job_id = $1",
    [accepted.jobId],
  ))[0];
  ctx.expectStatus(await ctx.callApi(ctx.apiOrigin, "POST", `/assets/${asset.id}/review`, {
    ifMatch: Number(asset.row_version),
    body: { decision: "APPROVE", note: "export source", contentHash: asset.checksum_sha256 },
  }), 200);
  return { ...shot, assetId: asset.id };
}

async function renderEpisode(ctx, episodeId, ids, approve) {
  const projectId = ctx.state.world.projectId;
  const preflight = ctx.expectStatus(await ctx.callApi(ctx.apiOrigin, "POST", `/projects/${projectId}/episodes/${episodeId}/compose-preflight`, {
    body: { compositeAssetIds: ids },
  }), 200).body;
  const accepted = ctx.expectStatus(await ctx.callApi(ctx.apiOrigin, "POST", `/projects/${projectId}/episodes/${episodeId}/compose`, {
    body: { compositeAssetIds: ids, expectedInputHash: preflight.inputHash },
  }), 202).body;
  const done = await ctx.pollJob(accepted.jobId, 180_000);
  if (done.state !== "SUCCEEDED") throw new Error(`export episode composite ${done.state} ${done.errorCode ?? ""}`);
  const asset = (await ctx.sql(
    `SELECT id::text AS id, row_version, checksum_sha256, byte_size, source_job_attempt_id::text AS attempt_id
       FROM asset WHERE source_generation_job_id = $1`,
    [accepted.jobId],
  ))[0];
  if (approve) {
    ctx.expectStatus(await ctx.callApi(ctx.apiOrigin, "POST", `/assets/${asset.id}/review`, {
      ifMatch: Number(asset.row_version),
      body: { decision: "APPROVE", note: "export", contentHash: asset.checksum_sha256 },
    }), 200);
  }
  return { ...asset, jobId: accepted.jobId, inputHash: preflight.inputHash };
}

async function episodeOne(ctx) {
  const episode = ctx.expectStatus(await ctx.callApi(ctx.apiOrigin, "GET", `/projects/${ctx.state.world.projectId}/episodes`), 200)
    .body.items.find((item) => item.episodeNo === 1);
  if (!episode) throw new Error("episode 1 is missing");
  return episode;
}

function exportPath(ctx, assetId, checksum) {
  const episodeId = ctx.state.episodeExport?.episodeId;
  return `/projects/${ctx.state.world.projectId}/episodes/${episodeId}/composites/${assetId}/download?expectedContentHash=${checksum}`;
}

async function assertManifestMatchesDatabase(ctx, assetId, manifest) {
  const row = (await ctx.sql("SELECT metadata_json, checksum_sha256, reviewed_content_hash FROM asset WHERE id = $1", [assetId]))[0];
  const segments = row.metadata_json.manifest.segments;
  if (row.checksum_sha256 !== manifest.asset.checksumSha256 || row.reviewed_content_hash !== manifest.asset.reviewedContentHash) {
    throw new Error("manifest hash does not match the asset row");
  }
  if (segments.length !== manifest.segments.length) throw new Error("manifest segment count drifted");
  for (let index = 0; index < segments.length; index += 1) {
    const frozen = segments[index];
    const listed = manifest.segments[index];
    if (frozen.assetId !== listed.shotAssetId || frozen.position !== listed.position || frozen.checksumSha256 !== listed.shotChecksumSha256) {
      throw new Error(`manifest segment ${index} does not match the frozen manifest`);
    }
    const edges = await ctx.sql(
      "SELECT source_asset_id::text AS source_asset_id FROM asset_dependency WHERE dependent_asset_id = $1 ORDER BY source_asset_id",
      [frozen.assetId],
    );
    const mediaIds = listed.media.map((item) => item.assetId).sort();
    if (mediaIds.join() !== edges.map((edge) => edge.source_asset_id).join()) {
      throw new Error(`manifest media ${mediaIds.join()} edges ${edges.map((edge) => edge.source_asset_id).join()}`);
    }
  }
  const episodeEdges = await ctx.sql(
    "SELECT source_asset_id::text AS source_asset_id FROM asset_dependency WHERE dependent_asset_id = $1 ORDER BY source_asset_id",
    [assetId],
  );
  const shotIds = manifest.segments.map((segment) => segment.shotAssetId).sort();
  if (shotIds.join() !== episodeEdges.map((edge) => edge.source_asset_id).join()) {
    throw new Error("episode dependency edges do not match the manifest");
  }
  if (JSON.stringify(manifest).includes("objectKey") || JSON.stringify(manifest).includes(ctx.composeObjectDir)) {
    throw new Error("manifest exported a local path");
  }
}

async function probeMp4(file, byteSize) {
  const probe = await execFileAsync("ffprobe", ["-v", "error", "-show_streams", "-show_format", "-of", "json", file], { encoding: "utf8" });
  const parsed = JSON.parse(probe.stdout);
  const video = parsed.streams?.find((stream) => stream.codec_type === "video");
  if (!video || Number(video.width) !== 1080 || Number(video.height) !== 1920) {
    throw new Error(`export probe ${JSON.stringify(video ?? null)}`);
  }
  if (Number(parsed.format?.size) !== byteSize) throw new Error(`export probe size ${parsed.format?.size}`);
  await execFileAsync("ffmpeg", ["-v", "error", "-i", file, "-f", "null", "-"]);
}

async function withPendingStale(ctx, run) {
  const require = createRequire(join(ctx.repo, "packages/database/package.json"));
  const { Client } = require("pg");
  const client = new Client({ connectionString: ctx.databaseUrl, statement_timeout: 10_000 });
  const ref = `episode-export-${ctx.state.episodeExport.assetId}`;
  await client.connect();
  try {
    await client.query(
      `INSERT INTO stale_recalculation (workspace_id, project_id, stale_from_ref, reason, status)
       VALUES ($1, $2, $3, 'episode export gate', 'PENDING')`,
      [ctx.workspaceId, ctx.state.world.projectId, ref],
    );
    await run();
  } finally {
    await client.query("UPDATE stale_recalculation SET status = 'DONE', updated_at = now() WHERE stale_from_ref = $1", [ref]).catch(() => undefined);
    await client.end();
  }
}

async function waitExportIdle(ctx) {
  await waitForCurrentSources(ctx);
  const started = Date.now();
  while (Date.now() - started < 60_000) {
    const jobs = await ctx.sql(
      "SELECT count(*)::int AS count FROM generation_job WHERE project_id = $1 AND state IN ('QUEUED', 'RUNNING')",
      [ctx.state.world.projectId],
    );
    const pending = await ctx.sql(
      "SELECT count(*)::int AS count FROM stale_recalculation WHERE project_id = $1 AND status IN ('PENDING', 'RUNNING')",
      [ctx.state.world.projectId],
    );
    if (jobs[0].count === 0 && pending[0].count === 0) return;
    await ctx.sleep(500);
  }
  throw new Error("episode export jobs were still active");
}

async function exportSnapshot(ctx) {
  const snapshot = {};
  for (const table of EPISODE_FINGERPRINT_TABLES) {
    snapshot[table] = summarizeLedgerTable(await ctx.sql(episodeFingerprintQuery(table)));
  }
  return snapshot;
}
