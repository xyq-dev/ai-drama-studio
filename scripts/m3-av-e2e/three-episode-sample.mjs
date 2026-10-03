import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { summarizeLedgerTable } from "./compose-preflight.mjs";
import { EPISODE_FINGERPRINT_TABLES, episodeFingerprintChanges, episodeFingerprintQuery } from "./episode-compose-preflight.mjs";

const execFileAsync = promisify(execFile);
const PLAN = [
  { episodeNo: 1, durationMs: 60000, fixtures: ["sample-15s-a-v1", "sample-15s-b-v1", "sample-15s-a-v1", "sample-15s-b-v1"] },
  { episodeNo: 2, durationMs: 75000, fixtures: ["sample-15s-b-v1", "sample-15s-a-v1", "sample-15s-b-v1", "sample-15s-a-v1", "sample-15s-b-v1"] },
  { episodeNo: 3, durationMs: 90000, fixtures: ["sample-15s-a-v1", "sample-15s-b-v1", "sample-15s-a-v1", "sample-15s-b-v1", "sample-15s-a-v1", "sample-15s-b-v1"] },
];

export async function sampleVideoFixtures(ctx) {
  const { SAMPLE_VIDEO_DESCRIPTIONS } = contract(ctx);
  const files = [];
  for (const description of Object.values(SAMPLE_VIDEO_DESCRIPTIONS)) {
    const file = join(ctx.repo, "packages", "providers", "fixtures", `${description.fixtureId}.mp4`);
    const bytes = await readFile(file);
    const checksumSha256 = createHash("sha256").update(bytes).digest("hex");
    if (checksumSha256 !== description.checksumSha256 || bytes.length !== description.byteSize || bytes.length > 1024 * 1024) {
      throw new Error(`committed sample ${description.fixtureId} ${bytes.length} ${checksumSha256}`);
    }
    const probe = await probeJson(file);
    const video = probe.streams.find((stream) => stream.codec_type === "video");
    const audio = probe.streams.find((stream) => stream.codec_type === "audio");
    if (
      probe.streams.length !== 1 || audio || !video ||
      video.codec_name !== "h264" || video.pix_fmt !== "yuv420p" ||
      Number(video.width) !== 180 || Number(video.height) !== 320 ||
      video.avg_frame_rate !== "5/1" || video.nb_frames !== "75" ||
      video.duration !== "15.000000" || probe.format.duration !== "15.000000" ||
      Number(probe.format.size) !== description.byteSize
    ) {
      throw new Error(`sample probe ${description.fixtureId} ${JSON.stringify(probe.streams[0] ?? null)}`);
    }
    await execFileAsync("ffmpeg", ["-v", "error", "-i", file, "-f", "null", "-"]);
    const start = await frameMd5(file, 0);
    const middle = await frameMd5(file, 37);
    const end = await frameMd5(file, 74);
    if (new Set([start, middle, end]).size !== 3) throw new Error(`sample ${description.fixtureId} frames did not change`);
    files.push({ fixtureId: description.fixtureId, byteSize: bytes.length, checksumSha256, frames: [start, middle, end] });
  }
  return { files, regenerated: false };
}

export async function sampleVideoGatesRecovery(ctx) {
  await ctx.stopApp("worker");
  await ctx.startWorker();
  const project = await createTechnicalProject(ctx, "技术验收样片门禁");
  const episode = project.episodes.find((item) => item.episodeNo === 1);
  const prepared = await prepareEpisode(ctx, project, episode, 3, null);
  const [idempotentShot, recoveryShot, boundShot] = prepared.shots;
  const before = await projectJobs(ctx, project.projectId);
  const names = [];
  try {
    const unsetEnv = ctx.childEnv({ API_PORT: "3051" }, ["M4_MOCK_SAMPLE_VIDEO_ENABLED"]);
    if (Object.hasOwn(unsetEnv, "M4_MOCK_SAMPLE_VIDEO_ENABLED")) throw new Error("unset did not remove the sample video switch");
    ctx.spawnApp("api-sample-unset", ["pnpm", "--filter", "@ai-drama/api", "start"], unsetEnv);
    ctx.spawnApp("api-sample-off", ["pnpm", "--filter", "@ai-drama/api", "start"], ctx.appEnv({
      API_PORT: "3052",
      M4_MOCK_SAMPLE_VIDEO_ENABLED: "false",
    }));
    ctx.spawnApp("api-sample-prod", ["pnpm", "--filter", "@ai-drama/api", "start"], ctx.appEnv({
      API_PORT: "3053",
      NODE_ENV: "production",
      M4_MOCK_SAMPLE_VIDEO_ENABLED: "true",
      M3_MOCK_AV_ENABLED: "true",
    }));
    names.push("api-sample-unset", "api-sample-off", "api-sample-prod");
    for (const port of [3051, 3052, 3053]) {
      await ctx.waitHttp(`http://127.0.0.1:${port}/api/v1/health/ready`, (status, body) => status === 200 && body?.dependencies?.postgres?.status === "ok", 60_000);
    }
    const path = `/shot-revisions/${idempotentShot.revisionId}/generate-video`;
    for (const base of ["http://127.0.0.1:3051", "http://127.0.0.1:3052", "http://127.0.0.1:3053"]) {
      ctx.expectStatus(await ctx.callApi(base, "POST", path, { body: { fixtureId: "sample-15s-a-v1" } }), 400, "CONFIGURATION_ERROR");
    }
    const ordinary = ctx.expectStatus(await ctx.callApi("http://127.0.0.1:3052", "POST", path, { body: {} }), 202).body;
    const ordinaryDone = await ctx.pollJob(ordinary.jobId, 120_000);
    if (ordinaryDone.state !== "SUCCEEDED") throw new Error(`ordinary video with sample switch off ${ordinaryDone.state}`);
    const ordinaryLedger = await ctx.jobLedger(ordinary.jobId);
    const ordinaryRequest = ordinaryLedger.attempts[0]?.provider_request_id ?? "";
    if (!ordinaryRequest.startsWith("mock-media|sync|video.generate|") || ordinaryLedger.assets[0]?.duration_ms !== "1000") {
      throw new Error(`ordinary video changed ${ordinaryRequest} ${ordinaryLedger.assets[0]?.duration_ms}`);
    }
  } finally {
    for (const name of names) await ctx.stopApp(name);
  }
  ctx.expectStatus(await ctx.callApi(ctx.apiOrigin, "POST", `/shot-revisions/${idempotentShot.revisionId}/generate-video`, {
    body: { fixtureId: "sample-15s-c-v1" },
  }), 400, "VALIDATION_ERROR");
  for (const route of ["generate-image", "generate-tts", "generate-subtitle", "generate-music"]) {
    ctx.expectStatus(await ctx.callApi(ctx.apiOrigin, "POST", `/shot-revisions/${idempotentShot.revisionId}/${route}`, {
      body: { fixtureId: "sample-15s-a-v1" },
    }), 400, "VALIDATION_ERROR");
  }
  const key = "sample-fixture-idempotency";
  const first = ctx.expectStatus(await ctx.callApi(ctx.apiOrigin, "POST", `/shot-revisions/${idempotentShot.revisionId}/generate-video`, {
    key, body: { fixtureId: "sample-15s-a-v1" },
  }), 202).body;
  const firstDone = await ctx.pollJob(first.jobId, 120_000);
  if (firstDone.state !== "SUCCEEDED") throw new Error(`sample idempotent create ${firstDone.state}`);
  const replay = ctx.expectStatus(await ctx.callApi(ctx.apiOrigin, "POST", `/shot-revisions/${idempotentShot.revisionId}/generate-video`, {
    key, body: { fixtureId: "sample-15s-a-v1" },
  }), 202).body;
  if (replay.jobId !== first.jobId) throw new Error("sample replay created another job");
  ctx.expectStatus(await ctx.callApi(ctx.apiOrigin, "POST", `/shot-revisions/${idempotentShot.revisionId}/generate-video`, {
    key, body: { fixtureId: "sample-15s-b-v1" },
  }), 409, "IDEMPOTENCY_KEY_REUSED");
  const replayLedger = await ctx.jobLedger(first.jobId);
  if (replayLedger.assets.length !== 1 || replayLedger.costs.length !== 1) throw new Error("sample replay added an asset or cost");
  const recovery = await recoverSample(ctx, recoveryShot.revisionId);
  const bound = await failBoundSample(ctx, boundShot.revisionId);
  const afterOrdinary = await projectJobs(ctx, project.projectId);
  if (afterOrdinary < before + 4) throw new Error(`sample gates did not record the expected jobs ${before} -> ${afterOrdinary}`);
  return {
    projectId: project.projectId,
    recovery,
    bound,
    submitCountMeasured: false,
  };
}

export async function threeEpisodeRender(ctx) {
  const project = await createTechnicalProject(ctx, "技术验收样片");
  let locationRevisionId = null;
  const episodes = [];
  for (const plan of PLAN) {
    const episode = project.episodes.find((item) => item.episodeNo === plan.episodeNo);
    const prepared = await prepareEpisode(ctx, project, episode, plan.fixtures.length, locationRevisionId);
    locationRevisionId = prepared.locationRevisionId;
    const shots = [];
    for (let index = 0; index < plan.fixtures.length; index += 1) {
      const shot = prepared.shots[index];
      const video = await generateSample(ctx, shot.revisionId, plan.fixtures[index]);
      const mixed = index === 0 ? await generateSupport(ctx, shot.revisionId) : null;
      const started = Date.now();
      const composite = await composeShot(ctx, shot.revisionId, video.assetId, mixed);
      shots.push({ ...shot, fixtureId: plan.fixtures[index], video, mixed, composite, renderMs: Date.now() - started });
    }
    const browser = await composeEpisodeInBrowser(ctx, project.projectId, episode, shots.map((shot) => shot.composite.assetId), plan.durationMs);
    episodes.push({ episodeNo: plan.episodeNo, episodeId: episode.id, durationMs: plan.durationMs, shots, ...browser });
  }
  ctx.state.sampleEpisodes = { projectId: project.projectId, episodes };
  return {
    projectId: project.projectId,
    episodes: episodes.map((episode) => ({
      episodeNo: episode.episodeNo,
      assetId: episode.assetId,
      checksumSha256: episode.checksumSha256,
      byteSize: episode.byteSize,
      durationMs: episode.durationMs,
      probeDuration: episode.playback.duration,
      width: episode.playback.width,
      height: episode.playback.height,
      ended: episode.playback.ended,
      decodedFrames: episode.playback.decodedFrames,
      renderMs: episode.renderMs,
      shotCount: episode.shots.length,
    })),
  };
}

export async function threeEpisodeDelivery(ctx) {
  const saved = ctx.state.sampleEpisodes;
  if (!saved) throw new Error("three episode sample was not rendered");
  const episodeThree = saved.episodes.find((item) => item.episodeNo === 3);
  if (!episodeThree || episodeThree.durationMs !== 90_000) throw new Error("episode 3 sample was not rendered");
  const candidateIds = (episodeThree.shots ?? []).map((shot) => shot.composite?.assetId);
  const page = ctx.state.page;
  await page.setViewportSize({ width: 390, height: 844 });
  const viewport = page.viewportSize();
  if (!viewport || viewport.width !== 390 || viewport.height !== 844) {
    throw new Error(`sample viewport ${JSON.stringify(viewport)}`);
  }
  await page.goto(`${ctx.webOrigin}/projects/${saved.projectId}?focus=episode-compose&episode=3`, { waitUntil: "domcontentloaded", timeout: 30_000 });
  const captured = await captureEpisodeThreeViewport(page, ctx.outputDir, episodeThree.assetId, candidateIds);
  await waitSampleIdle(ctx, saved.projectId);
  const before = await fingerprint(ctx);
  const downloads = [];
  for (const episode of saved.episodes) {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`${ctx.webOrigin}/projects/${saved.projectId}?focus=episode-compose&episode=${episode.episodeNo}`, { waitUntil: "domcontentloaded", timeout: 30_000 });
    const card = page.locator(`[data-composite-id="${episode.assetId}"]`);
    await card.getByRole("button", { name: "下载 MP4" }).waitFor({ timeout: 20_000 });
    const mp4Path = join(ctx.outputDir, `sample-episode-${episode.episodeNo}.mp4`);
    const jsonPath = join(ctx.outputDir, `sample-episode-${episode.episodeNo}.json`);
    await saveDownload(page, card.getByRole("button", { name: "下载 MP4" }), mp4Path);
    await saveDownload(page, card.getByRole("button", { name: "下载来源清单" }), jsonPath);
    const mp4 = await readFile(mp4Path);
    const manifest = JSON.parse(await readFile(jsonPath, "utf8"));
    const checksumSha256 = createHash("sha256").update(mp4).digest("hex");
    if (checksumSha256 !== episode.checksumSha256 || mp4.length !== episode.byteSize) {
      throw new Error(`download ${episode.episodeNo} ${checksumSha256} ${mp4.length}`);
    }
    await assertManifest(ctx, episode, manifest);
    const decoded = await decodeEpisode(mp4Path, episode);
    downloads.push({ episodeNo: episode.episodeNo, checksumSha256, byteSize: mp4.length, manifestJobId: manifest.compose.jobId, decoded });
  }
  await page.goto(`${ctx.webOrigin}/projects/${saved.projectId}`, { waitUntil: "domcontentloaded", timeout: 30_000 });
  const costWait = page.waitForResponse((response) => response.url().includes(`/projects/${saved.projectId}/cost-summary`) && response.request().method() === "GET", { timeout: 20_000 });
  await page.getByRole("button", { name: "已记录成本" }).click();
  const costHttp = await costWait;
  if (!costHttp.ok()) throw new Error(`sample cost summary ${costHttp.status()}`);
  const summary = await costHttp.json();
  const ledger = await ctx.sql(
    `SELECT kind, currency, count(*)::int AS count, sum(amount_decimal)::text AS amount
       FROM cost_ledger WHERE project_id = $1 GROUP BY kind, currency ORDER BY kind, currency`,
    [saved.projectId],
  );
  const coverage = await ctx.sql(
    `SELECT
       (SELECT count(*)::int FROM generation_job WHERE project_id = $1) AS jobs,
       (SELECT count(*)::int FROM job_attempt attempt
          JOIN generation_job job ON job.id = attempt.generation_job_id
         WHERE job.project_id = $1 AND job.input_snapshot->>'schema' IN ('m4.shot.compose.v1', 'm4.episode.compose.v1')) AS local_compose
     `,
    [saved.projectId],
  );
  const usd = summary.currencies?.find((row) => row.currency === "USD");
  if (!usd || usd.actualAmount !== "0.00000000" || Number(usd.actualEntryCount) !== 24) {
    throw new Error(`sample cost summary ${JSON.stringify(summary.currencies)}`);
  }
  if (ledger.length !== 1 || ledger[0].kind !== "ACTUAL" || ledger[0].currency !== "USD" || Number(ledger[0].amount) !== 0 || ledger[0].count !== 24) {
    throw new Error(`sample ledger ${JSON.stringify(ledger)}`);
  }
  if (coverage[0].local_compose !== 18 || summary.coverage?.localComposeAttemptCount !== 18) {
    throw new Error(`sample unmetered compose ${coverage[0].local_compose} ${summary.coverage?.localComposeAttemptCount}`);
  }
  const after = await fingerprint(ctx);
  const changes = episodeFingerprintChanges(before, after);
  if (changes.length > 0) throw new Error(`sample delivery changed stored records: ${changes.join(", ")}`);
  return {
    overflow: captured.overflow,
    viewport,
    assetId: episodeThree.assetId,
    page: captured.page,
    png: captured.png,
    layoutAttempt: captured.attempt,
    candidates: captured.candidates,
    targets: captured.targets,
    ready: captured.ready,
    screenshot: "three-episode-sample-390.png",
    downloads,
    ledger,
    localComposeAttempts: coverage[0].local_compose,
    unchanged: EPISODE_FINGERPRINT_TABLES.map((table) => ({ table, count: before[table].count, fingerprint: before[table].fingerprint })),
  };
}

async function captureEpisodeThreeViewport(page, outputDir, assetId, candidateIds) {
  let failure = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await waitEpisodeThreeCandidates(page, candidateIds);
    const ready = await waitEpisodeThreeReady(page, assetId);
    const before = await readEpisodeThreeLayout(page, assetId, candidateIds);
    const overflow = before.scrollWidth - before.clientWidth;
    if (overflow > 1) throw new Error(`sample episode overflow ${overflow}`);
    const pending = layoutGaps(before);
    if (pending.length > 0) {
      failure = { attempt, pending, before };
      continue;
    }
    const file = join(outputDir, "three-episode-sample-390.png");
    await page.screenshot({ path: file, fullPage: true });
    const after = await readEpisodeThreeLayout(page, assetId, candidateIds);
    const png = await pngSize(file);
    const shifted = layoutShift(before, after);
    const clipped = pngGaps(png, before);
    if (shifted.length === 0 && clipped.length === 0) {
      return {
        attempt,
        overflow,
        ready,
        page: {
          scrollWidth: before.scrollWidth,
          scrollHeight: before.scrollHeight,
          clientWidth: before.clientWidth,
          clientHeight: before.clientHeight,
        },
        png,
        candidates: before.candidates,
        targets: { card: before.card, video: before.video, mp4: before.mp4, manifest: before.manifest },
      };
    }
    failure = { attempt, shifted, clipped, before, after, png };
  }
  throw new Error(`episode 3 layout changed during the 390px screenshot ${JSON.stringify(failure)}`);
}

async function waitEpisodeThreeCandidates(page, candidateIds) {
  if (!Array.isArray(candidateIds) || candidateIds.length !== 6 || candidateIds.some((id) => typeof id !== "string") || new Set(candidateIds).size !== 6) {
    throw new Error(`episode 3 candidates ${JSON.stringify(candidateIds)}`);
  }
  await page.waitForFunction((ids) => {
    const shown = (node) => {
      if (!node) return false;
      const style = window.getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    };
    const loading = [...document.querySelectorAll("p")].some((node) => node.textContent.includes("正在加载候选成片") && shown(node));
    return ids.length === 6 && !loading && ids.every((id) => shown(document.querySelector(`[data-asset-id="${id}"]`)));
  }, candidateIds, { timeout: 30_000 });
}

async function readEpisodeThreeLayout(page, assetId, candidateIds) {
  return page.evaluate(({ assetId, candidateIds }) => {
    const box = (node) => {
      if (!node) return null;
      const rect = node.getBoundingClientRect();
      return {
        x: Math.round(rect.left + window.scrollX),
        y: Math.round(rect.top + window.scrollY),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      };
    };
    const shown = (node) => {
      if (!node) return false;
      const style = window.getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    };
    const root = document.documentElement;
    const card = document.querySelector(`[data-composite-id="${assetId}"]`);
    const buttons = card ? [...card.querySelectorAll("button")] : [];
    const labeled = (name) => buttons.find((button) => button.textContent.trim() === name) ?? null;
    return {
      scrollWidth: Math.round(root.scrollWidth),
      scrollHeight: Math.round(root.scrollHeight),
      clientWidth: Math.round(root.clientWidth),
      clientHeight: Math.round(root.clientHeight),
      loading: [...document.querySelectorAll("p")].some((node) => node.textContent.includes("正在加载候选成片") && shown(node)),
      candidates: candidateIds.map((id) => box(document.querySelector(`[data-asset-id="${id}"]`))),
      card: box(card),
      video: box(card?.querySelector("video") ?? null),
      mp4: box(labeled("下载 MP4")),
      manifest: box(labeled("下载来源清单")),
    };
  }, { assetId, candidateIds });
}

function layoutGaps(layout) {
  const gaps = [];
  if (layout.loading) gaps.push("loading");
  if (layout.candidates.length !== 6) gaps.push("candidate-count");
  layout.candidates.forEach((box, index) => {
    if (!box || box.width <= 0 || box.height <= 0) gaps.push(`candidate-${index}`);
  });
  for (const name of ["card", "video", "mp4", "manifest"]) {
    const box = layout[name];
    if (!box || box.width <= 0 || box.height <= 0) gaps.push(name);
  }
  return gaps;
}

function layoutShift(before, after) {
  const changed = ["scrollWidth", "scrollHeight", "clientWidth", "clientHeight", "loading"].filter((field) => before[field] !== after[field]);
  for (const name of ["card", "video", "mp4", "manifest"]) {
    if (JSON.stringify(before[name]) !== JSON.stringify(after[name])) changed.push(name);
  }
  if (JSON.stringify(before.candidates) !== JSON.stringify(after.candidates)) changed.push("candidates");
  return changed;
}

function pngGaps(png, layout) {
  const gaps = [];
  if (png.width !== layout.scrollWidth || png.height !== layout.scrollHeight) gaps.push("png-size");
  [...layout.candidates, layout.card, layout.video, layout.mp4, layout.manifest].forEach((box, index) => {
    if (!box || box.x < 0 || box.y < 0 || box.x + box.width > png.width || box.y + box.height > png.height) gaps.push(`clip-${index}`);
  });
  return gaps;
}

async function pngSize(file) {
  const bytes = await readFile(file);
  if (bytes.length < 24 || bytes[0] !== 0x89 || bytes.toString("ascii", 1, 4) !== "PNG") throw new Error("episode 3 screenshot is not a png");
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), byteSize: bytes.length };
}

async function waitEpisodeThreeReady(page, assetId) {
  const card = page.locator(`[data-composite-id="${assetId}"][data-asset-status="ACTIVE"][data-review-status="APPROVED"]`);
  await card.waitFor({ state: "visible", timeout: 30_000 });
  await card.getByText("审核 APPROVED").waitFor({ state: "visible", timeout: 20_000 });
  const mp4 = card.getByRole("button", { name: "下载 MP4" });
  const manifest = card.getByRole("button", { name: "下载来源清单" });
  await mp4.waitFor({ state: "visible", timeout: 20_000 });
  await manifest.waitFor({ state: "visible", timeout: 20_000 });
  const video = card.locator("video");
  await video.waitFor({ state: "visible", timeout: 20_000 });
  const boxes = {
    card: await card.boundingBox(),
    mp4: await mp4.boundingBox(),
    manifest: await manifest.boundingBox(),
    video: await video.boundingBox(),
  };
  if (Object.entries(boxes).some(([, box]) => !box || box.width <= 0 || box.height <= 0)) {
    throw new Error(`episode 3 controls are not visible ${JSON.stringify(boxes)}`);
  }
  const metadata = await video.evaluate(async (node, expectedAssetId) => {
    const media = node;
    if (media.readyState < 1) {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("episode 3 loadedmetadata timeout")), 20_000);
        media.addEventListener("loadedmetadata", () => { clearTimeout(timer); resolve(); }, { once: true });
      });
    }
    return {
      readyState: media.readyState,
      videoWidth: media.videoWidth,
      videoHeight: media.videoHeight,
      duration: media.duration,
      src: media.currentSrc || media.getAttribute("src") || "",
      expectedAssetId,
    };
  }, assetId);
  const durationMs = Math.round(metadata.duration * 1000);
  if (
    metadata.readyState < 1
    || metadata.videoWidth !== 1080
    || metadata.videoHeight !== 1920
    || Math.abs(durationMs - 90_000) > 40
    || !metadata.src.includes(assetId)
  ) {
    throw new Error(`episode 3 metadata ${JSON.stringify({ ...metadata, durationMs })}`);
  }
  return {
    assetId,
    assetStatus: "ACTIVE",
    reviewStatus: "APPROVED",
    mp4Visible: true,
    manifestVisible: true,
    readyState: metadata.readyState,
    videoWidth: metadata.videoWidth,
    videoHeight: metadata.videoHeight,
    durationMs,
    boxes,
  };
}

async function recoverSample(ctx, revisionId) {
  await ctx.breakMockDir();
  try {
    const accepted = ctx.expectStatus(await ctx.callApi(ctx.apiOrigin, "POST", `/shot-revisions/${revisionId}/generate-video`, {
      body: { fixtureId: "sample-15s-b-v1" },
    }), 202).body;
    const attached = await ctx.waitAttachedRequest(accepted.jobId);
    const attemptId = attached.attempts[0].id;
    const requestId = attached.attempts[0].provider_request_id;
    await ctx.stopApp("worker");
    await ctx.restoreMockDir();
    await ctx.startWorker();
    const done = await ctx.pollJob(accepted.jobId, 120_000);
    const ledger = await ctx.jobLedger(accepted.jobId);
    if (done.state !== "SUCCEEDED") throw new Error(`sample recovery ${done.state} ${ledger.job?.error_code ?? ""}`);
    if (ledger.attempts.length !== 1 || ledger.attempts[0].id !== attemptId || ledger.attempts[0].provider_request_id !== requestId) {
      throw new Error(`sample recovery changed attempt ${JSON.stringify(ledger.attempts)}`);
    }
    if (ledger.assets.length !== 1 || ledger.costs.length !== 1 || Number(ledger.costs[0].amount_decimal) !== 0 || ledger.costs[0].kind !== "ACTUAL") {
      throw new Error("sample recovery did not leave one asset and one zero actual cost");
    }
    if (ledger.assets[0].checksum_sha256 !== "21f1c5ac372b71337e2a615e3994fdbf812aa79b7a7dc0a88c6de13401e8e60f") {
      throw new Error("recovered sample bytes are not fixture B");
    }
    return { jobId: accepted.jobId, attemptId, requestId, assetId: ledger.assets[0].id, submitCountMeasured: false };
  } finally {
    await ctx.restoreMockDir();
  }
}

async function failBoundSample(ctx, revisionId) {
  await ctx.breakMockDir();
  try {
    const accepted = ctx.expectStatus(await ctx.callApi(ctx.apiOrigin, "POST", `/shot-revisions/${revisionId}/generate-video`, {
      body: { fixtureId: "sample-15s-a-v1" },
    }), 202).body;
    const attached = await ctx.waitAttachedRequest(accepted.jobId);
    const attemptId = attached.attempts[0].id;
    const requestId = attached.attempts[0].provider_request_id;
    await ctx.stopApp("worker");
    await ctx.restoreMockDir();
    ctx.spawnApp("worker", ["pnpm", "--filter", "@ai-drama/worker", "start"], ctx.appEnv({
      M3_MOCK_AV_ENABLED: "true",
      M4_MOCK_SAMPLE_VIDEO_ENABLED: "false",
    }));
    await ctx.waitHttp(`${ctx.workerOrigin}/health/ready`, (status, body) => status === 200 && body?.dependencies?.queue?.status === "ok", 60_000);
    const done = await ctx.pollJob(accepted.jobId, 120_000);
    const ledger = await ctx.jobLedger(accepted.jobId);
    if (done.state !== "FAILED" || ledger.job?.error_code !== "MOCK_MEDIA_NOT_CONFIGURED") {
      throw new Error(`bound sample with switch off ${done.state} ${ledger.job?.error_code}`);
    }
    if (ledger.attempts.length !== 1 || ledger.attempts[0].id !== attemptId || ledger.attempts[0].provider_request_id !== requestId) {
      throw new Error("bound sample attempt changed");
    }
    if (ledger.assets.length !== 0 || ledger.costs.length !== 0) throw new Error("disabled sample recovery wrote an asset or cost");
    const ordinary = ctx.expectStatus(await ctx.callApi(ctx.apiOrigin, "POST", `/shot-revisions/${revisionId}/generate-video`, {
      body: { seed: "ordinary-while-sample-off" },
    }), 202).body;
    const ordinaryDone = await ctx.pollJob(ordinary.jobId, 120_000);
    const ordinaryLedger = await ctx.jobLedger(ordinary.jobId);
    if (ordinaryDone.state !== "SUCCEEDED" || ordinaryLedger.assets[0]?.duration_ms !== "1000") {
      throw new Error("ordinary video failed while the sample switch was off");
    }
    await ctx.stopApp("worker");
    await ctx.startWorker();
    return { jobId: accepted.jobId, attemptId, requestId, ordinaryJobId: ordinary.jobId };
  } finally {
    await ctx.restoreMockDir();
  }
}

async function createTechnicalProject(ctx, title) {
  const project = ctx.expectStatus(await ctx.callApi(ctx.apiOrigin, "POST", "/projects", {
    body: { title, premise: "技术验收样片，不是短剧成片。" },
  }), 201).body;
  const story = ctx.expectStatus(await ctx.callApi(ctx.apiOrigin, "POST", `/projects/${project.id}/stories`, {
    ifMatch: project.version,
    body: { content: { schema: "m2.story.revision.v1", premise: "技术验收样片，不是短剧成片。" } },
  }), 201).body;
  await ctx.approve(ctx.apiOrigin, `/projects/${project.id}/stories/${story.revisionId}/review`, story.rowVersion);
  const episodes = ctx.expectStatus(await ctx.callApi(ctx.apiOrigin, "GET", `/projects/${project.id}/episodes`), 200).body.items;
  if (episodes.length !== 3) throw new Error(`story approval created ${episodes.length} episodes`);
  return { projectId: project.id, storyRevisionId: story.revisionId, episodes };
}

async function prepareEpisode(ctx, project, episode, shotCount, locationRevisionId) {
  const currentEpisode = await episodeById(ctx, project.projectId, episode.id);
  const script = ctx.expectStatus(await ctx.callApi(ctx.apiOrigin, "POST", `/projects/${project.projectId}/episodes/${episode.id}/scripts`, {
    ifMatch: currentEpisode.rowVersion,
    body: {
      storyRevisionId: project.storyRevisionId,
      content: {
        schema: "m2.script.revision.v1",
        episode: episode.episodeNo,
        title: `技术验收样片 第${episode.episodeNo}集`,
        body: "技术验收样片，不是短剧成片。",
        scenes: [],
      },
    },
  }), 201).body;
  await ctx.approve(ctx.apiOrigin, `/projects/${project.projectId}/episodes/${episode.id}/scripts/${script.revisionId}/review`, script.rowVersion);
  let locationId = locationRevisionId;
  if (!locationId) {
    const version = ctx.expectStatus(await ctx.callApi(ctx.apiOrigin, "GET", `/projects/${project.projectId}`), 200).body.version;
    const character = ctx.expectStatus(await ctx.callApi(ctx.apiOrigin, "POST", `/projects/${project.projectId}/characters`, {
      ifMatch: version,
      body: { name: "技术验收样片", sourceScriptRevisionId: script.revisionId, content: { role: "sample" } },
    }), 201).body;
    await ctx.approve(ctx.apiOrigin, `/projects/${project.projectId}/characters/${character.entityId}/revisions/${character.revisionId}/review`, character.rowVersion);
    const locationVersion = ctx.expectStatus(await ctx.callApi(ctx.apiOrigin, "GET", `/projects/${project.projectId}`), 200).body.version;
    const location = ctx.expectStatus(await ctx.callApi(ctx.apiOrigin, "POST", `/projects/${project.projectId}/locations`, {
      ifMatch: locationVersion,
      body: { name: "技术验收样片", sourceScriptRevisionId: script.revisionId, content: { kind: "sample" } },
    }), 201).body;
    await ctx.approve(ctx.apiOrigin, `/projects/${project.projectId}/locations/${location.entityId}/revisions/${location.revisionId}/review`, location.rowVersion);
    locationId = location.revisionId;
  }
  const episodeForScene = await episodeById(ctx, project.projectId, episode.id);
  const scene = ctx.expectStatus(await ctx.callApi(ctx.apiOrigin, "POST", `/projects/${project.projectId}/episodes/${episode.id}/scenes`, {
    ifMatch: episodeForScene.rowVersion,
    body: {
      sourceScriptRevisionId: script.revisionId,
      locationRevisionId: locationId,
      ordinal: 1,
      heading: "技术验收样片",
      summary: "技术验收样片，不是短剧成片。",
    },
  }), 201).body;
  await ctx.approve(ctx.apiOrigin, `/projects/${project.projectId}/episodes/${episode.id}/scenes/${scene.entityId}/revisions/${scene.revisionId}/review`, scene.rowVersion);
  const shots = [];
  for (let ordinal = 1; ordinal <= shotCount; ordinal += 1) {
    const sceneVersion = ctx.expectStatus(await ctx.callApi(
      ctx.apiOrigin, "GET",
      `/projects/${project.projectId}/episodes/${episode.id}/scenes/${scene.entityId}/revisions`,
    ), 200).body.aggregate.rowVersion;
    const created = ctx.expectStatus(await ctx.callApi(
      ctx.apiOrigin, "POST",
      `/projects/${project.projectId}/episodes/${episode.id}/scenes/${scene.entityId}/shots`,
      {
        ifMatch: sceneVersion,
        body: ctx.shotPayload(
          scene.revisionId,
          ordinal,
          "技术验收样片",
          `技术验收样片 第${episode.episodeNo}集镜头${ordinal}`,
          "技术验收样片对白",
        ),
      },
    ), 201);
    await ctx.approve(
      ctx.apiOrigin,
      `/projects/${project.projectId}/episodes/${episode.id}/scenes/${scene.entityId}/shots/${created.body.entityId}/revisions/${created.body.revisionId}/review`,
      created.body.rowVersion,
    );
    shots.push({ shotId: created.body.entityId, revisionId: created.body.revisionId, ordinal });
  }
  return { locationRevisionId: locationId, shots };
}

async function generateSample(ctx, revisionId, fixtureId) {
  const accepted = ctx.expectStatus(await ctx.callApi(ctx.apiOrigin, "POST", `/shot-revisions/${revisionId}/generate-video`, {
    body: { fixtureId },
  }), 202).body;
  const done = await ctx.pollJob(accepted.jobId, 120_000);
  const ledger = await ctx.jobLedger(accepted.jobId);
  const requestId = `mock-media|sample-sync-v1|video.generate|${fixtureId}|${accepted.jobId}:1`;
  if (done.state !== "SUCCEEDED" || ledger.attempts[0]?.provider_request_id !== requestId || ledger.assets.length !== 1 || ledger.costs.length !== 1) {
    throw new Error(`sample video ${fixtureId} ${done.state} ${ledger.job?.error_code ?? ""}`);
  }
  if (ledger.job.input_snapshot?.schema !== "m4.mock.sample-video.v1" || ledger.job.input_snapshot?.fixtureId !== fixtureId) {
    throw new Error("sample snapshot does not match the request");
  }
  if (ledger.assets[0].duration_ms !== "15000" || ledger.assets[0].width !== 180 || ledger.assets[0].height !== 320) {
    throw new Error(`sample asset shape ${ledger.assets[0].width}x${ledger.assets[0].height} ${ledger.assets[0].duration_ms}`);
  }
  return { jobId: accepted.jobId, attemptId: ledger.attempts[0].id, requestId, assetId: ledger.assets[0].id };
}

async function generateSupport(ctx, revisionId) {
  const created = {};
  for (const route of ["generate-tts", "generate-music", "generate-subtitle"]) {
    const accepted = ctx.expectStatus(await ctx.callApi(ctx.apiOrigin, "POST", `/shot-revisions/${revisionId}/${route}`, { body: {} }), 202).body;
    const done = await ctx.pollJob(accepted.jobId, 120_000);
    if (done.state !== "SUCCEEDED") throw new Error(`${route} ${done.state}`);
    const ledger = await ctx.jobLedger(accepted.jobId);
    created[route] = ledger.assets[0].id;
  }
  return { audioAssetId: created["generate-tts"], musicAssetId: created["generate-music"], subtitleAssetId: created["generate-subtitle"] };
}

async function composeShot(ctx, revisionId, videoAssetId, mixed) {
  const body = { videoAssetId, audioAssetId: mixed?.audioAssetId ?? null, musicAssetId: mixed?.musicAssetId ?? null, subtitleAssetId: mixed?.subtitleAssetId ?? null };
  const preflight = ctx.expectStatus(await ctx.callApi(ctx.apiOrigin, "POST", `/shot-revisions/${revisionId}/compose-preflight`, { body }), 200).body;
  const accepted = ctx.expectStatus(await ctx.callApi(ctx.apiOrigin, "POST", `/shot-revisions/${revisionId}/compose`, {
    body: { ...body, expectedInputHash: preflight.inputHash },
  }), 202).body;
  const done = await ctx.pollJob(accepted.jobId, 240_000);
  if (done.state !== "SUCCEEDED") throw new Error(`shot compose ${done.state} ${done.errorCode ?? ""}`);
  const asset = (await ctx.sql(
    "SELECT id::text AS id, row_version, checksum_sha256, byte_size, duration_ms FROM asset WHERE source_generation_job_id = $1",
    [accepted.jobId],
  ))[0];
  ctx.expectStatus(await ctx.callApi(ctx.apiOrigin, "POST", `/assets/${asset.id}/review`, {
    ifMatch: Number(asset.row_version),
    body: { decision: "APPROVE", note: "技术验收样片", contentHash: asset.checksum_sha256 },
  }), 200);
  return { assetId: asset.id, checksumSha256: asset.checksum_sha256, byteSize: Number(asset.byte_size), durationMs: Number(asset.duration_ms), jobId: accepted.jobId };
}

async function composeEpisodeInBrowser(ctx, projectId, episode, compositeIds, durationMs) {
  const page = ctx.state.page;
  await page.goto(`${ctx.webOrigin}/projects/${projectId}?focus=episode-compose&episode=${episode.episodeNo}`, { waitUntil: "domcontentloaded", timeout: 30_000 });
  for (const assetId of compositeIds) {
    await page.locator(`[data-asset-id="${assetId}"]`).getByRole("button", { name: "加入" }).click();
  }
  await page.getByRole("button", { name: "预检编排" }).click();
  await page.getByText("inputHash").waitFor({ timeout: 20_000 });
  const started = Date.now();
  const responsePromise = page.waitForResponse((response) =>
    response.url().includes(`/episodes/${episode.id}/compose`) && !response.url().includes("preflight") && response.request().method() === "POST",
  { timeout: 20_000 });
  await page.getByRole("button", { name: "开始多镜合成" }).click();
  const response = await responsePromise;
  if (response.status() !== 202) throw new Error(`episode compose was not accepted ${response.status()}`);
  const accepted = await response.json();
  const done = await ctx.pollJob(accepted.jobId, 300_000);
  const renderMs = Date.now() - started;
  if (done.state !== "SUCCEEDED") throw new Error(`episode ${episode.episodeNo} compose ${done.state} ${done.errorCode ?? ""}`);
  const asset = (await ctx.sql(
    `SELECT id::text AS id, checksum_sha256, byte_size, duration_ms, width, height, status, review_status,
            source_generation_job_id::text AS job_id, source_job_attempt_id::text AS attempt_id, metadata_json
       FROM asset WHERE source_generation_job_id = $1`,
    [accepted.jobId],
  ))[0];
  if (Number(asset.duration_ms) !== durationMs || asset.width !== 1080 || asset.height !== 1920) {
    throw new Error(`episode asset ${asset.width}x${asset.height} ${asset.duration_ms}`);
  }
  const card = page.locator(`[data-composite-id="${asset.id}"]`);
  await card.waitFor({ timeout: 30_000 });
  await card.getByRole("button", { name: "批准成片" }).click();
  await card.getByText("审核 APPROVED").waitFor({ timeout: 20_000 });
  const playback = await card.locator("video").evaluate(async (node, expectedSeconds) => {
    const media = node;
    media.muted = true;
    media.playbackRate = 16;
    if (media.readyState < 2) {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("decoded frame timeout")), 20000);
        media.addEventListener("loadeddata", () => { clearTimeout(timer); resolve(); }, { once: true });
      });
    }
    await media.play();
    const samples = [];
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("playback did not end")), Math.ceil(expectedSeconds / 16 * 1000) + 20000);
      media.addEventListener("timeupdate", () => {
        if (samples.length < 8) samples.push(media.currentTime);
      });
      media.addEventListener("ended", () => { clearTimeout(timer); resolve(); }, { once: true });
    });
    const quality = typeof media.getVideoPlaybackQuality === "function" ? media.getVideoPlaybackQuality() : null;
    return {
      width: media.videoWidth,
      height: media.videoHeight,
      duration: media.duration,
      currentTime: media.currentTime,
      ended: media.ended,
      samples,
      decodedFrames: quality ? quality.totalVideoFrames : null,
      droppedFrames: quality ? quality.droppedVideoFrames : null,
    };
  }, durationMs / 1000);
  if (!playback.ended || playback.width !== 1080 || playback.height !== 1920 || !(playback.decodedFrames > 0)) {
    throw new Error(`episode playback ${JSON.stringify(playback)}`);
  }
  const stale = await ctx.sql(
    "SELECT count(*)::int AS count FROM stale_recalculation WHERE project_id = $1 AND status IN ('PENDING', 'RUNNING')",
    [projectId],
  );
  if (stale[0].count !== 0 || asset.status !== "ACTIVE") throw new Error("sample episode is stale or inactive");
  const approved = (await ctx.sql("SELECT review_status, reviewed_content_hash, checksum_sha256 FROM asset WHERE id = $1", [asset.id]))[0];
  if (approved.review_status !== "APPROVED" || approved.reviewed_content_hash !== approved.checksum_sha256) {
    throw new Error("sample review hash does not match");
  }
  return {
    assetId: asset.id,
    checksumSha256: asset.checksum_sha256,
    byteSize: Number(asset.byte_size),
    jobId: asset.job_id,
    attemptId: asset.attempt_id,
    renderMs,
    playback,
  };
}

async function assertManifest(ctx, episode, manifest) {
  if (manifest.asset.checksumSha256 !== episode.checksumSha256 || manifest.asset.reviewedContentHash !== episode.checksumSha256) {
    throw new Error("manifest review hash drifted");
  }
  if (manifest.compose.jobId !== episode.jobId || manifest.compose.attemptId !== episode.attemptId) {
    throw new Error("manifest job identity drifted");
  }
  if (manifest.asset.durationMs !== episode.durationMs || manifest.segments.length !== episode.shots.length) {
    throw new Error("manifest duration or segment count drifted");
  }
  const edges = await ctx.sql(
    "SELECT source_asset_id::text AS source_asset_id FROM asset_dependency WHERE dependent_asset_id = $1 ORDER BY source_asset_id",
    [episode.assetId],
  );
  const shotIds = episode.shots.map((shot) => shot.composite.assetId).sort();
  if (shotIds.join() !== edges.map((edge) => edge.source_asset_id).join()) throw new Error("episode source edges drifted");
  for (let index = 0; index < episode.shots.length; index += 1) {
    const listed = manifest.segments[index];
    const shot = episode.shots[index];
    if (listed.shotAssetId !== shot.composite.assetId || listed.durationMs !== 15000) {
      throw new Error(`segment ${index} does not match the shot composite`);
    }
  }
}

async function decodeEpisode(file, episode) {
  const probe = await probeJson(file);
  const video = probe.streams.find((stream) => stream.codec_type === "video");
  await execFileAsync("ffmpeg", ["-v", "error", "-i", file, "-f", "null", "-"]);
  const probeMs = Math.round(Number(probe.format.duration) * 1000);
  const browserMs = Math.round(episode.playback.duration * 1000);
  const tolerance = {
    assetMs: episode.durationMs,
    probeMs,
    browserMs,
    probeDeltaMs: probeMs - episode.durationMs,
    browserDeltaMs: browserMs - episode.durationMs,
  };
  if (Math.abs(tolerance.probeDeltaMs) > 40 || Math.abs(tolerance.browserDeltaMs) > 40) {
    throw new Error(`duration tolerance ${JSON.stringify(tolerance)}`);
  }
  if (Number(video.width) !== 1080 || Number(video.height) !== 1920) throw new Error("decoded dimensions drifted");
  const framesPerSegment = 15 * 25;
  const samples = [];
  for (let index = 0; index < episode.shots.length; index += 1) {
    const origin = index * framesPerSegment;
    const frames = [origin + 25, origin + 187, origin + 350];
    const hashes = [];
    const colors = [];
    for (const frame of frames) {
      hashes.push(await frameMd5(file, frame));
      colors.push(await frameColor(file, frame));
    }
    if (new Set(hashes).size !== 3) throw new Error(`segment ${index} did not change over time`);
    const expected = episode.shots[index].fixtureId.endsWith("-a-v1") ? "A" : "B";
    if (colors.some((color) => color !== expected)) throw new Error(`segment ${index} color ${colors.join(",")} expected ${expected}`);
    samples.push({ index, expected, colors, hashes });
  }
  return { width: Number(video.width), height: Number(video.height), tolerance, samples };
}

async function frameMd5(file, frame) {
  const result = await execFileAsync("ffmpeg", [
    "-v", "error", "-i", file, "-vf", `select=eq(n\\,${frame})`, "-frames:v", "1", "-f", "md5", "-",
  ], { encoding: "utf8" });
  return result.stdout.trim();
}

async function frameColor(file, frame) {
  const result = await execFileAsync("ffmpeg", [
    "-v", "error", "-i", file,
    "-vf", `select=eq(n\\,${frame}),crop=2:2:500:1600,scale=1:1`,
    "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1",
  ], { encoding: "buffer", maxBuffer: 1024 * 1024 });
  const red = result.stdout[0] ?? 0;
  const blue = result.stdout[2] ?? 0;
  if (blue > 80 && blue > red + 40) return "A";
  if (red > 80 && red > blue + 40) return "B";
  throw new Error(`frame ${frame} color ${red},${result.stdout[1]},${blue}`);
}

async function probeJson(file) {
  const probe = await execFileAsync("ffprobe", ["-v", "error", "-show_streams", "-show_format", "-of", "json", file], { encoding: "utf8" });
  return JSON.parse(probe.stdout);
}

async function episodeById(ctx, projectId, episodeId) {
  const episode = ctx.expectStatus(await ctx.callApi(ctx.apiOrigin, "GET", `/projects/${projectId}/episodes`), 200)
    .body.items.find((item) => item.id === episodeId);
  if (!episode) throw new Error("episode missing");
  return episode;
}

async function projectJobs(ctx, projectId) {
  const rows = await ctx.sql("SELECT count(*)::int AS count FROM generation_job WHERE project_id = $1", [projectId]);
  return rows[0].count;
}

async function waitSampleIdle(ctx, projectId) {
  const started = Date.now();
  while (Date.now() - started < 60_000) {
    const jobs = await ctx.sql(
      "SELECT count(*)::int AS count FROM generation_job WHERE project_id = $1 AND state IN ('QUEUED', 'RUNNING')",
      [projectId],
    );
    const pending = await ctx.sql(
      "SELECT count(*)::int AS count FROM stale_recalculation WHERE project_id = $1 AND status IN ('PENDING', 'RUNNING')",
      [projectId],
    );
    if (jobs[0].count === 0 && pending[0].count === 0) return;
    await ctx.sleep(500);
  }
  throw new Error("sample project was still active");
}

async function fingerprint(ctx) {
  const snapshot = {};
  for (const table of EPISODE_FINGERPRINT_TABLES) {
    snapshot[table] = summarizeLedgerTable(await ctx.sql(episodeFingerprintQuery(table)));
  }
  return snapshot;
}

async function saveDownload(page, button, target) {
  const [download] = await Promise.all([
    page.waitForEvent("download", { timeout: 60_000 }),
    button.click(),
  ]);
  await download.saveAs(target);
}

function contract(ctx) {
  const require = createRequire(join(ctx.repo, "packages", "contracts", "package.json"));
  return require("@ai-drama/contracts");
}
