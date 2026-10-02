import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { LEDGER_TABLES, summarizeLedgerTable } from "./compose-preflight.mjs";
import { createSideShot, replaceSideScene, waitForCurrentSources } from "./compose-preflight.mjs";

export const EPISODE_FINGERPRINT_TABLES = [
  ...LEDGER_TABLES,
  "asset_dependency",
  "asset_revision_dependency",
  "idempotency_record",
];

export function episodeFingerprintQuery(table) {
  if (!EPISODE_FINGERPRINT_TABLES.includes(table)) throw new Error(`unexpected episode fingerprint table ${table}`);
  if (table === "asset_dependency") {
    return "SELECT dependent_asset_id::text || ':' || source_asset_id::text AS id, md5(row_to_json(t)::text) AS fingerprint FROM asset_dependency t ORDER BY 1";
  }
  return `SELECT id::text AS id, md5(row_to_json(t)::text) AS fingerprint FROM ${table} t ORDER BY id`;
}

export function episodeFingerprintChanges(before, after) {
  const changes = [];
  for (const table of EPISODE_FINGERPRINT_TABLES) {
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

async function episodeSnapshot(ctx) {
  const snapshot = {};
  for (const table of EPISODE_FINGERPRINT_TABLES) {
    snapshot[table] = summarizeLedgerTable(await ctx.sql(episodeFingerprintQuery(table)));
  }
  return snapshot;
}

async function waitIdle(ctx) {
  await waitForCurrentSources(ctx);
  const started = Date.now();
  while (Date.now() - started < 60_000) {
    const rows = await ctx.sql(
      "SELECT count(*)::int AS count FROM generation_job WHERE project_id = $1 AND state IN ('QUEUED', 'RUNNING')",
      [ctx.state.world.projectId],
    );
    if (rows[0].count === 0) return;
    await ctx.sleep(500);
  }
  throw new Error("episode compose jobs were still active");
}

async function approveComposite(ctx, shot) {
  const preflight = ctx.expectStatus(await ctx.callApi(ctx.apiOrigin, "POST", `/shot-revisions/${shot.revisionId}/compose-preflight`, {
    body: { videoAssetId: shot.videoId },
  }), 200).body;
  const accepted = ctx.expectStatus(await ctx.callApi(ctx.apiOrigin, "POST", `/shot-revisions/${shot.revisionId}/compose`, {
    body: { videoAssetId: shot.videoId, expectedInputHash: preflight.inputHash },
  }), 202).body;
  const done = await ctx.pollJob(accepted.jobId, 180_000);
  if (done.state !== "SUCCEEDED") throw new Error(`episode composite ${done.state} ${done.errorCode ?? ""}`);
  const asset = (await ctx.sql(
    "SELECT id::text AS id, row_version, checksum_sha256, duration_ms FROM asset WHERE source_generation_job_id = $1",
    [accepted.jobId],
  ))[0];
  ctx.expectStatus(await ctx.callApi(ctx.apiOrigin, "POST", `/assets/${asset.id}/review`, {
    ifMatch: Number(asset.row_version),
    body: { decision: "APPROVE", note: "episode candidate", contentHash: asset.checksum_sha256 },
  }), 200);
  return { ...shot, assetId: asset.id, durationMs: Number(asset.duration_ms) };
}

function episodeUrl(ctx) {
  return `${ctx.webOrigin}/projects/${ctx.state.world.projectId}?focus=episode-compose&episode=1`;
}

function shotUrl(ctx) {
  return `${ctx.webOrigin}/projects/${ctx.state.world.projectId}?focus=shot&episode=1&scene=${ctx.state.world.sceneId}&shot=${ctx.state.world.shotId}`;
}

async function episodeRecord(ctx) {
  const episodes = ctx.expectStatus(await ctx.callApi(
    ctx.apiOrigin, "GET", `/projects/${ctx.state.world.projectId}/episodes`,
  ), 200).body.items;
  const episode = episodes.find((item) => item.episodeNo === 1);
  const other = episodes.find((item) => item.episodeNo === 2);
  if (!episode || !other) throw new Error("episode 1 and 2 are required");
  return { episode, other };
}

export async function episodeComposePreflight(ctx) {
  const page = ctx.state.page;
  await page.goto(shotUrl(ctx), { waitUntil: "domcontentloaded", timeout: 30_000 });
  if (await page.locator("#shot-action").inputValue() !== ctx.draftMarker) {
    throw new Error("shot draft changed before episode compose");
  }
  const first = await approveComposite(ctx, await createSideShot(ctx));
  const second = await approveComposite(ctx, await createSideShot(ctx));
  if (first.revisionId === second.revisionId || first.assetId === second.assetId) {
    throw new Error("episode candidates were not two different shots");
  }
  await waitIdle(ctx);
  const before = await episodeSnapshot(ctx);
  const { episode } = await episodeRecord(ctx);
  await page.goto(episodeUrl(ctx), { waitUntil: "domcontentloaded", timeout: 30_000 });
  const panel = page.getByRole("region", { name: "多镜编排" });
  await panel.getByRole("heading", { name: "多镜编排" }).waitFor({ timeout: 30_000 });
  await panel.locator(`[data-asset-id="${first.assetId}"]`).getByRole("button", { name: "加入" }).click();
  await panel.locator(`[data-asset-id="${second.assetId}"]`).getByRole("button", { name: "加入" }).click();
  await panel.locator(`[data-selected-asset-id="${first.assetId}"]`).getByText("0–").waitFor({ timeout: 10_000 });
  const responsePromise = page.waitForResponse((response) =>
    response.url().includes(`/episodes/${episode.id}/compose-preflight`) && response.request().method() === "POST",
  { timeout: 20_000 });
  await panel.getByRole("button", { name: "预检编排" }).click();
  const response = await responsePromise;
  const payload = await response.json();
  if (response.status() !== 200 || response.headers()["cache-control"] !== "private, no-store") {
    throw new Error(`episode preflight ${response.status()} ${response.headers()["cache-control"]}`);
  }
  if (payload.schema !== "m4.episode.compose.preflight.v1" || payload.executed !== false || payload.verification !== "metadata") {
    throw new Error(`episode preflight payload ${JSON.stringify(payload)}`);
  }
  if (payload.diskContentChecked !== false || payload.decoded !== false) throw new Error("episode preflight claims media inspection");
  if (payload.durationNotice !== "尚未达到 V1 的 60–90 秒目标") throw new Error(`duration notice ${payload.durationNotice}`);
  const segments = payload.manifest?.segments ?? [];
  if (segments.map((segment) => segment.assetId).join() !== [first.assetId, second.assetId].join()) {
    throw new Error(`episode order ${JSON.stringify(segments)}`);
  }
  if (segments[0].startMs !== 0 || segments[0].endMs !== segments[0].durationMs) throw new Error("timeline does not start at 0");
  if (segments[1].startMs !== segments[0].endMs || segments[1].endMs !== segments[0].endMs + segments[1].durationMs) {
    throw new Error(`timeline ${JSON.stringify(segments)}`);
  }
  if (JSON.stringify(payload.manifest).includes("rowVersion")) throw new Error("manifest includes rowVersion");
  await panel.getByText("预检通过，尚未执行多镜合成").waitFor({ timeout: 10_000 });
  await panel.getByText(`inputHash ${payload.inputHash}`).waitFor({ timeout: 10_000 });
  await panel.locator(`[data-selected-asset-id="${second.assetId}"]`).getByRole("button", { name: "上移" }).click();
  await panel.getByText(`inputHash ${payload.inputHash}`).waitFor({ state: "hidden", timeout: 10_000 });
  const againPromise = page.waitForResponse((response) =>
    response.url().includes(`/episodes/${episode.id}/compose-preflight`) && response.request().method() === "POST",
  { timeout: 20_000 });
  await panel.getByRole("button", { name: "预检编排" }).click();
  const again = await againPromise;
  const reordered = await again.json();
  if (again.status() !== 200 || reordered.inputHash === payload.inputHash) throw new Error("reordered preflight did not change the hash");
  if (reordered.manifest.segments.map((segment) => segment.assetId).join() !== [second.assetId, first.assetId].join()) {
    throw new Error(`reordered segments ${JSON.stringify(reordered.manifest.segments)}`);
  }
  const after = await episodeSnapshot(ctx);
  const changes = episodeFingerprintChanges(before, after);
  if (changes.length > 0) throw new Error(`browser episode preflight changed stored records: ${changes.join(", ")}`);
  await page.setViewportSize({ width: 390, height: 844 });
  const overflow = await page.evaluate(() => ({
    documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    bodyOverflow: document.body.scrollWidth - document.body.clientWidth,
  }));
  if (overflow.documentOverflow > 1 || overflow.bodyOverflow > 1) throw new Error(`390px overflow ${JSON.stringify(overflow)}`);
  await page.screenshot({ path: join(ctx.outputDir, "episode-compose-390.png"), fullPage: true });
  await page.setViewportSize({ width: 1280, height: 900 });
  ctx.state.episodeCompose = { episodeId: episode.id, first, second, inputHash: payload.inputHash, reorderedHash: reordered.inputHash };
  return { episodeId: episode.id, first: first.assetId, second: second.assetId, inputHash: payload.inputHash, reorderedHash: reordered.inputHash, overflow };
}

export async function episodeComposeGates(ctx) {
  const prepared = ctx.state.episodeCompose;
  if (!prepared) throw new Error("episode compose candidates were not prepared");
  const { episode, other } = await episodeRecord(ctx);
  const body = { compositeAssetIds: [prepared.first.assetId, prepared.second.assetId] };
  const path = `/projects/${ctx.state.world.projectId}/episodes/${episode.id}/compose-preflight`;
  const stable = ctx.expectStatus(await ctx.callApi(ctx.apiOrigin, "POST", path, { body }), 200).body;
  const repeated = ctx.expectStatus(await ctx.callApi(ctx.apiOrigin, "POST", path, { body }), 200).body;
  if (stable.inputHash !== repeated.inputHash) throw new Error("repeated episode preflight hash changed");
  const swapped = ctx.expectStatus(await ctx.callApi(ctx.apiOrigin, "POST", path, {
    body: { compositeAssetIds: [prepared.second.assetId, prepared.first.assetId] },
  }), 200).body;
  if (swapped.inputHash === stable.inputHash) throw new Error("swapped episode preflight kept the same hash");
  ctx.expectStatus(await ctx.callApi(ctx.apiOrigin, "POST", path, {
    body: { compositeAssetIds: [prepared.first.assetId, prepared.second.assetId], workspaceId: ctx.workspaceId },
  }), 400, "VALIDATION_ERROR");
  ctx.expectStatus(await ctx.callApi(ctx.apiOrigin, "POST", path, {
    body: { compositeAssetIds: [prepared.first.assetId, prepared.first.assetId] },
  }), 400, "VALIDATION_ERROR");
  ctx.expectStatus(await ctx.callApi(ctx.apiOrigin, "POST", path, {
    body: { compositeAssetIds: [prepared.first.assetId] },
  }), 400, "VALIDATION_ERROR");
  ctx.expectStatus(await ctx.callApi(ctx.apiOrigin, "POST", `/projects/${ctx.state.world.projectId}/episodes/${other.id}/compose-preflight`, { body }), 400, "COMPOSE_INPUT_INVALID");
  ctx.expectStatus(await ctx.callApi(ctx.apiOrigin, "POST", `/projects/${randomUUID()}/episodes/${episode.id}/compose-preflight`, { body }), 404, "NOT_FOUND");
  ctx.spawnApp("api-episode-other", ["pnpm", "--filter", "@ai-drama/api", "start"], ctx.appEnv({
    API_PORT: "3027",
    APP_WORKSPACE_ID: ctx.otherWorkspaceId,
    APP_WORKSPACE_NAME: "M4 episode other",
  }));
  try {
    await ctx.waitHttp("http://127.0.0.1:3027/api/v1/health/ready", (status, payload) => status === 200 && payload?.dependencies?.postgres?.status === "ok", 60_000);
    ctx.expectStatus(await ctx.callApi("http://127.0.0.1:3027", "POST", path, { body }), 404, "NOT_FOUND");
  } finally {
    await ctx.stopApp("api-episode-other");
  }
  const stale = (await ctx.sql(
    "SELECT id::text AS id FROM asset WHERE project_id = $1 AND kind = 'COMPOSITE' AND status = 'STALE' LIMIT 1",
    [ctx.state.world.projectId],
  ))[0];
  const rejected = (await ctx.sql(
    "SELECT id::text AS id FROM asset WHERE project_id = $1 AND kind = 'COMPOSITE' AND review_status = 'REJECTED' LIMIT 1",
    [ctx.state.world.projectId],
  ))[0];
  if (!stale || !rejected) throw new Error(`missing stale or rejected composite ${JSON.stringify({ stale, rejected })}`);
  ctx.expectStatus(await ctx.callApi(ctx.apiOrigin, "POST", path, {
    body: { compositeAssetIds: [prepared.first.assetId, stale.id] },
  }), 400, "COMPOSE_INPUT_INVALID");
  ctx.expectStatus(await ctx.callApi(ctx.apiOrigin, "POST", path, {
    body: { compositeAssetIds: [prepared.first.assetId, rejected.id] },
  }), 400, "COMPOSE_INPUT_INVALID");
  const draft = await composeWithoutReview(ctx, prepared.first);
  ctx.expectStatus(await ctx.callApi(ctx.apiOrigin, "POST", path, {
    body: { compositeAssetIds: [prepared.first.assetId, draft.assetId] },
  }), 400, "COMPOSE_INPUT_INVALID");
  ctx.expectStatus(await ctx.callApi(ctx.apiOrigin, "POST", `/assets/${draft.assetId}/review`, {
    ifMatch: draft.rowVersion,
    body: { decision: "APPROVE", note: "same shot second composite", contentHash: draft.checksum },
  }), 200);
  const duplicate = await ctx.callApi(ctx.apiOrigin, "POST", path, {
    body: { compositeAssetIds: [prepared.first.assetId, draft.assetId] },
  });
  ctx.expectStatus(duplicate, 400, "COMPOSE_INPUT_INVALID");
  if (!JSON.stringify(duplicate.body).includes("同一个镜头只能选择一份成片")) {
    throw new Error(`duplicate shot was not rejected ${JSON.stringify(duplicate.body)}`);
  }
  const still = ctx.expectStatus(await ctx.callApi(ctx.apiOrigin, "POST", path, {
    body: { compositeAssetIds: [prepared.first.assetId, prepared.second.assetId] },
  }), 200).body;
  if (still.inputHash !== stable.inputHash) throw new Error("a newer composite replaced the selected preflight");
  return { stableHash: stable.inputHash, swappedHash: swapped.inputHash };
}

export async function episodeComposeReadonly(ctx) {
  const prepared = ctx.state.episodeCompose;
  if (!prepared) throw new Error("episode compose candidates were not prepared");
  await waitIdle(ctx);
  const before = await episodeSnapshot(ctx);
  const path = `/projects/${ctx.state.world.projectId}/episodes/${prepared.episodeId}/compose-preflight`;
  const body = { compositeAssetIds: [prepared.first.assetId, prepared.second.assetId] };
  ctx.expectStatus(await ctx.callApi(ctx.apiOrigin, "POST", path, { body }), 200);
  ctx.expectStatus(await ctx.callApi(ctx.apiOrigin, "POST", path, { body }), 200);
  const after = await episodeSnapshot(ctx);
  const changes = episodeFingerprintChanges(before, after);
  if (changes.length > 0) throw new Error(`episode preflight changed stored records: ${changes.join(", ")}`);
  await replaceSideScene(ctx, prepared.first);
  await waitForCurrentSources(ctx);
  const blockedBefore = await episodeSnapshot(ctx);
  const blocked = await ctx.callApi(ctx.apiOrigin, "POST", path, { body });
  if (blocked.status === 200) throw new Error("upstream revision change still passed episode preflight");
  ctx.expectStatus(blocked, 400, "REVIEW_REQUIRED");
  const blockedAfter = await episodeSnapshot(ctx);
  const blockedChanges = episodeFingerprintChanges(blockedBefore, blockedAfter);
  if (blockedChanges.length > 0) throw new Error(`rejected episode preflight changed stored records: ${blockedChanges.join(", ")}`);
  const panel = ctx.state.page.getByRole("region", { name: "多镜编排" });
  await panel.getByRole("button", { name: "预检编排" }).click();
  await panel.getByRole("alert").waitFor({ timeout: 20_000 });
  await panel.locator(`[data-selected-asset-id="${prepared.first.assetId}"]`).waitFor({ timeout: 10_000 });
  await panel.locator(`[data-selected-asset-id="${prepared.second.assetId}"]`).waitFor({ timeout: 10_000 });
  if (await panel.getByText("预检通过，尚未执行多镜合成").count()) {
    throw new Error("rejected episode preflight left a success note");
  }
  return {
    unchanged: EPISODE_FINGERPRINT_TABLES.map((table) => ({ table, count: before[table].count, fingerprint: before[table].fingerprint })),
    rejected: blocked.body?.error?.code ?? "REVIEW_REQUIRED",
  };
}

async function composeWithoutReview(ctx, shot) {
  const preflight = ctx.expectStatus(await ctx.callApi(ctx.apiOrigin, "POST", `/shot-revisions/${shot.revisionId}/compose-preflight`, {
    body: { videoAssetId: shot.videoId },
  }), 200).body;
  const accepted = ctx.expectStatus(await ctx.callApi(ctx.apiOrigin, "POST", `/shot-revisions/${shot.revisionId}/compose`, {
    body: { videoAssetId: shot.videoId, expectedInputHash: preflight.inputHash },
  }), 202).body;
  const done = await ctx.pollJob(accepted.jobId, 180_000);
  if (done.state !== "SUCCEEDED") throw new Error(`draft episode composite ${done.state}`);
  const asset = (await ctx.sql(
    "SELECT id::text AS id, row_version, checksum_sha256 FROM asset WHERE source_generation_job_id = $1",
    [accepted.jobId],
  ))[0];
  return { assetId: asset.id, rowVersion: Number(asset.row_version), checksum: asset.checksum_sha256 };
}
