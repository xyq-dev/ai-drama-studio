/**
 * Optional live API client for drama.playhubs.cn (or ADS_API_BASE).
 * Credentials come ONLY from env / config file path — never from chat args.
 *
 * Required for --live writes:
 *   ADS_API_BASE (default https://drama.playhubs.cn/api/v1)
 *   ADS_SESSION_COOKIE
 *   ADS_CSRF_TOKEN
 *   ADS_ORIGIN (must match SITE_AUTH_PUBLIC_ORIGIN)
 *
 * Paid paths (auto-runs, generate, authorize, confirm) are refused here.
 */
import { randomUUID } from "node:crypto";

const REFUSED_PATH_MARKERS = [
  "/auto-runs",
  "/writing/candidates",
  "/writing/series",
  "/real-media/generate",
  "/real-media/authorize",
  "/vimax-planning/requests",
  "/lines/",
  "/speech-batches/",
  "generate-image",
  "generate-video",
  "generate-tts",
  "generate-music",
];

export function liveConfigFromEnv(env = process.env) {
  const base = (env.ADS_API_BASE || "https://drama.playhubs.cn/api/v1").replace(/\/$/, "");
  const cookie = env.ADS_SESSION_COOKIE || "";
  const csrf = env.ADS_CSRF_TOKEN || "";
  const origin = env.ADS_ORIGIN || "";
  return { base, cookie, csrf, origin };
}

export function assertLiveReady(cfg) {
  const missing = [];
  if (!cfg.cookie) missing.push("ADS_SESSION_COOKIE");
  if (!cfg.csrf) missing.push("ADS_CSRF_TOKEN");
  if (!cfg.origin) missing.push("ADS_ORIGIN");
  if (missing.length) {
    throw new Error(
      `Live mode needs protected credentials (missing: ${missing.join(", ")}). ` +
        `Put them in an env file / vault-backed config — never paste into chat. Falling back to local store.`,
    );
  }
}

export function assertPathAllowed(method, path) {
  const p = path.toLowerCase();
  for (const marker of REFUSED_PATH_MARKERS) {
    if (p.includes(marker.toLowerCase())) {
      throw new Error(`Refusing paid/blocked path in native tools: ${method} ${path}`);
    }
  }
  // Allow speech-batches GET list only — marker is broad; refine:
  // marker "/speech-batches/" blocks nested paid confirm; bare GET /speech-batches ok if needed later
}

export async function apiRequest(cfg, method, path, { body, idempotencyKey, ifMatch } = {}) {
  assertPathAllowed(method, path);
  assertLiveReady(cfg);
  const url = `${cfg.base}${path.startsWith("/") ? path : `/${path}`}`;
  /** @type {Record<string, string>} */
  const headers = {
    Accept: "application/json",
    Origin: cfg.origin,
    Cookie: cfg.cookie,
  };
  if (method !== "GET" && method !== "HEAD") {
    headers["Content-Type"] = "application/json";
    headers["X-CSRF-Token"] = cfg.csrf;
  }
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
  if (ifMatch != null) headers["If-Match"] = String(ifMatch);

  const response = await fetch(url, {
    method,
    headers,
    body: body == null ? undefined : JSON.stringify(body),
    redirect: "manual",
  });
  let data = null;
  const text = await response.text();
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text.slice(0, 500) };
  }
  if (response.status >= 400) {
    const err = new Error(`API ${method} ${path} → ${response.status}`);
    err.status = response.status;
    err.data = data;
    throw err;
  }
  return { status: response.status, data };
}

export async function liveCreateProject(cfg, { title, premise }) {
  return apiRequest(cfg, "POST", "/projects", {
    body: { title, premise: premise || "" },
    idempotencyKey: `grokbot-create-${randomUUID()}`,
  });
}

export async function liveListProjects(cfg) {
  return apiRequest(cfg, "GET", "/projects");
}

export async function liveGetProject(cfg, projectId) {
  return apiRequest(cfg, "GET", `/projects/${projectId}`);
}

export async function liveSaveScript(cfg, { projectId, episodeId, text, ifMatch }) {
  return apiRequest(cfg, "POST", `/projects/${projectId}/episodes/${episodeId}/scripts`, {
    body: { text },
    idempotencyKey: `grokbot-script-${randomUUID()}`,
    ifMatch,
  });
}

export async function liveListEpisodes(cfg, projectId) {
  return apiRequest(cfg, "GET", `/projects/${projectId}/episodes`);
}

export async function liveListScripts(cfg, projectId, episodeId) {
  return apiRequest(cfg, "GET", `/projects/${projectId}/episodes/${episodeId}/scripts`);
}
