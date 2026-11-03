/**
 * Local project store for GrokBot native drama tools.
 * File-backed JSON under ADS_LOCAL_STORE (default: .grokbot-drama-store.json).
 * This is a Bot-side working cache / offline authority for text workflow when
 * live API credentials are absent. It is NOT a second GenerationJob database;
 * live mode prefers the server as source of truth.
 */
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

export function defaultStorePath() {
  return resolve(process.env.ADS_LOCAL_STORE || ".grokbot-drama-store.json");
}

export function emptyStore() {
  return { version: 1, currentProjectId: null, projects: {} };
}

export function loadStore(path = defaultStorePath()) {
  if (!existsSync(path)) return emptyStore();
  const raw = JSON.parse(readFileSync(path, "utf8"));
  if (!raw || typeof raw !== "object" || raw.version !== 1 || typeof raw.projects !== "object") {
    throw new Error(`Invalid store at ${path}`);
  }
  return raw;
}

export function saveStore(store, path = defaultStorePath()) {
  const dir = dirname(path);
  if (dir && dir !== ".") mkdirSync(dir, { recursive: true });
  writeFileSync(path, `${JSON.stringify(store, null, 2)}\n`, "utf8");
}

function nowIso() {
  return new Date().toISOString();
}

export function createProject(store, { title, premise = "", genre = "", audience = "", episodeCount = 1 }) {
  if (!title || typeof title !== "string") throw new Error("title is required");
  const id = randomUUID();
  const createdAt = nowIso();
  const project = {
    id,
    title: title.trim(),
    premise: String(premise || "").trim(),
    genre: String(genre || "").trim(),
    audience: String(audience || "").trim(),
    episodeCount: Math.max(1, Math.min(6, Number(episodeCount) || 1)),
    createdAt,
    updatedAt: createdAt,
    source: "local",
    episodes: [
      {
        id: randomUUID(),
        episodeNo: 1,
        title: "第1集",
        scripts: [],
      },
    ],
  };
  store.projects[id] = project;
  store.currentProjectId = id;
  return project;
}

export function listProjects(store) {
  return Object.values(store.projects).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

export function continueProject(store, projectId) {
  const id = projectId || store.currentProjectId;
  if (!id) throw new Error("No current project; pass --project-id or create one first");
  const project = store.projects[id];
  if (!project) throw new Error(`Unknown project: ${id}`);
  store.currentProjectId = id;
  project.updatedAt = nowIso();
  return project;
}

export function getProject(store, projectId) {
  const id = projectId || store.currentProjectId;
  if (!id) throw new Error("No current project; pass --project-id");
  const project = store.projects[id];
  if (!project) throw new Error(`Unknown project: ${id}`);
  return project;
}

export function saveScript(store, { projectId, episodeNo = 1, text, title }) {
  if (!text || typeof text !== "string" || !text.trim()) throw new Error("script text is required");
  const project = getProject(store, projectId);
  let episode = project.episodes.find((e) => e.episodeNo === Number(episodeNo));
  if (!episode) {
    episode = { id: randomUUID(), episodeNo: Number(episodeNo), title: `第${episodeNo}集`, scripts: [] };
    project.episodes.push(episode);
    project.episodes.sort((a, b) => a.episodeNo - b.episodeNo);
  }
  const revisionNo = episode.scripts.length + 1;
  const revision = {
    id: randomUUID(),
    revisionNo,
    title: title || `剧本修订 ${revisionNo}`,
    text: text.trim(),
    reviewStatus: "DRAFT",
    createdAt: nowIso(),
    contentHash: simpleHash(text.trim()),
  };
  episode.scripts.push(revision);
  project.updatedAt = nowIso();
  store.currentProjectId = project.id;
  return { project, episode, revision };
}

export function projectStatus(store, projectId) {
  const project = getProject(store, projectId);
  const scripts = project.episodes.flatMap((ep) =>
    ep.scripts.map((s) => ({
      episodeNo: ep.episodeNo,
      revisionId: s.id,
      revisionNo: s.revisionNo,
      reviewStatus: s.reviewStatus,
      contentHash: s.contentHash,
      title: s.title,
    })),
  );
  const latest = scripts[scripts.length - 1] || null;
  const blockers = [];
  if (scripts.length === 0) blockers.push("尚无剧本修订");
  else if (latest && latest.reviewStatus !== "APPROVED") blockers.push(`最新剧本未 APPROVED（${latest.reviewStatus}）`);
  return {
    projectId: project.id,
    title: project.title,
    premise: project.premise,
    genre: project.genre,
    audience: project.audience,
    episodeCount: project.episodeCount,
    source: project.source,
    updatedAt: project.updatedAt,
    scriptCount: scripts.length,
    latestScript: latest,
    scripts,
    blockers,
  };
}

function simpleHash(text) {
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (Math.imul(31, h) + text.charCodeAt(i)) | 0;
  return `local:${(h >>> 0).toString(16)}:${text.length}`;
}
