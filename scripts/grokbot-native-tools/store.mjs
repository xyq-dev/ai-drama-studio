/**
 * Local project store for GrokBot native drama tools.
 * File-backed JSON under ADS_LOCAL_STORE (default: .grokbot-drama-store.json).
 * Bot-side working cache for text/voice-plan workflow when live API credentials
 * are absent. NOT a second GenerationJob database; live mode prefers the server.
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

function touch(project) {
  project.updatedAt = nowIso();
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
    stage: "created",
    episodes: [
      {
        id: randomUUID(),
        episodeNo: 1,
        title: "第1集",
        scripts: [],
      },
    ],
    characters: [],
    scenes: [],
    voicePlan: null,
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
  touch(project);
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
  project.stage = "script_draft";
  touch(project);
  store.currentProjectId = project.id;
  return { project, episode, revision };
}

/**
 * Human approval gate for local store. Does NOT call live review API.
 * approvedBy should be an explicit actor string from the operator (e.g. user:yingqun-xu).
 */
export function approveScript(store, { projectId, episodeNo = 1, revisionId, approvedBy }) {
  if (!approvedBy || !String(approvedBy).trim()) {
    throw new Error("approvedBy is required (human gate; Bot must not forge APPROVE)");
  }
  const project = getProject(store, projectId);
  const episode = project.episodes.find((e) => e.episodeNo === Number(episodeNo));
  if (!episode) throw new Error(`Unknown episodeNo: ${episodeNo}`);
  let revision = revisionId
    ? episode.scripts.find((s) => s.id === revisionId)
    : episode.scripts[episode.scripts.length - 1];
  if (!revision) throw new Error("No script revision to approve");
  if (revision.reviewStatus === "APPROVED") {
    return { project, episode, revision, alreadyApproved: true };
  }
  revision.reviewStatus = "APPROVED";
  revision.approvedAt = nowIso();
  revision.approvedBy = String(approvedBy).trim();
  project.stage = "script_approved";
  touch(project);
  return { project, episode, revision, alreadyApproved: false };
}

export function setCharacters(store, { projectId, characters }) {
  const list = normalizeCharacters(characters);
  if (list.length === 0) throw new Error("characters required (JSON array or --characters-file)");
  const project = getProject(store, projectId);
  project.characters = list.map((c) => ({
    id: c.id || `char-${slug(c.name)}`,
    name: String(c.name).trim(),
    role: String(c.role || "").trim(),
    voiceIntent: String(c.voiceIntent || c.voice || "").trim(),
    notes: String(c.notes || "").trim(),
  }));
  project.stage = project.stage === "created" || project.stage === "script_draft" ? "characters_set" : project.stage;
  if (["script_approved", "scene_approved", "storyboard_set", "voice_plan"].includes(project.stage)) {
    // keep richer stage
  } else if (project.episodes.some((e) => e.scripts.some((s) => s.reviewStatus === "APPROVED"))) {
    project.stage = "characters_set";
  }
  touch(project);
  return { project, characters: project.characters };
}

export function setStoryboard(store, { projectId, scene }) {
  const normalized = normalizeScene(scene);
  const project = getProject(store, projectId);
  if (!Array.isArray(project.scenes)) project.scenes = [];
  const idx = project.scenes.findIndex(
    (s) => s.id === normalized.id || (s.episodeNo === normalized.episodeNo && s.title === normalized.title),
  );
  if (idx >= 0) project.scenes[idx] = { ...project.scenes[idx], ...normalized, status: normalized.status || project.scenes[idx].status || "DRAFT" };
  else project.scenes.push({ ...normalized, status: normalized.status || "DRAFT" });
  project.stage = "storyboard_set";
  touch(project);
  const saved = project.scenes[idx >= 0 ? idx : project.scenes.length - 1];
  return { project, scene: saved };
}

export function approveScene(store, { projectId, sceneId, approvedBy }) {
  if (!approvedBy || !String(approvedBy).trim()) {
    throw new Error("approvedBy is required (human gate; Bot must not forge APPROVE)");
  }
  const project = getProject(store, projectId);
  if (!Array.isArray(project.scenes) || project.scenes.length === 0) {
    throw new Error("No scenes to approve; run set-storyboard first");
  }
  let scene = sceneId ? project.scenes.find((s) => s.id === sceneId) : project.scenes[project.scenes.length - 1];
  if (!scene) throw new Error(`Unknown scene: ${sceneId}`);
  if (scene.status === "APPROVED") {
    return { project, scene, alreadyApproved: true };
  }
  scene.status = "APPROVED";
  scene.approvedAt = nowIso();
  scene.approvedBy = String(approvedBy).trim();
  project.stage = "scene_approved";
  touch(project);
  return { project, scene, alreadyApproved: false };
}

/**
 * Build a local voice plan from approved script lines + characters.
 * Never calls TTS. Records planned call counts and budget placeholders only.
 */
export function voicePlan(store, { projectId, episodeNo = 1, currency = "待填", budgetCap = "待你授权" } = {}) {
  const project = getProject(store, projectId);
  const episode = project.episodes.find((e) => e.episodeNo === Number(episodeNo));
  if (!episode) throw new Error(`Unknown episodeNo: ${episodeNo}`);
  const approved = [...episode.scripts].reverse().find((s) => s.reviewStatus === "APPROVED") || episode.scripts.at(-1);
  if (!approved) throw new Error("No script revision; save-script first");
  if (approved.reviewStatus !== "APPROVED") {
    throw new Error(`Latest usable script is ${approved.reviewStatus}; approve-script before voice-plan`);
  }
  if (!Array.isArray(project.characters) || project.characters.length === 0) {
    throw new Error("set-characters before voice-plan");
  }
  const scene = (project.scenes || []).find((s) => s.episodeNo === Number(episodeNo));
  if (!scene || scene.status !== "APPROVED") {
    throw new Error("approve-scene (after set-storyboard) before voice-plan");
  }

  const linesByChar = parseDialogueLines(approved.text);
  const characters = project.characters.map((c) => {
    const lines = linesByChar.get(c.name) || [];
    return {
      characterId: c.id,
      name: c.name,
      voiceVersionIntent: c.voiceIntent || "",
      lines,
      plannedTtsCalls: lines.length,
    };
  });
  const plannedTtsCalls = characters.reduce((n, c) => n + c.plannedTtsCalls, 0);
  const dialogueLines = plannedTtsCalls;
  const plan = {
    status: "PLAN_READY",
    mode: "quote_then_authorize",
    note: "未发起真实 TTS；需费用上限与媒体密钥后试听",
    scriptRevisionId: approved.id,
    sceneId: scene.id,
    characters,
    totals: {
      dialogueLines,
      plannedTtsCalls,
      suggestedMaxTts: Math.max(plannedTtsCalls * 3, plannedTtsCalls + 4),
      currency,
      budgetCap,
    },
    nextHumanSteps: [
      "确认币种与费用上限",
      "提供/核对 DASHSCOPE_MEDIA_* 就绪（或当前手册要求的媒体凭据）",
      "服务器只读核 SHA / drafts / Worker / 字体",
      "authorize 后逐句 generate→试听→选用（Bot 不自动选用）",
    ],
  };
  project.voicePlan = plan;
  project.stage = "voice_plan";
  touch(project);
  return { project, voicePlan: plan };
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
      approvedBy: s.approvedBy || null,
    })),
  );
  const latest = scripts[scripts.length - 1] || null;
  const scenes = (project.scenes || []).map((s) => ({
    id: s.id,
    episodeNo: s.episodeNo,
    title: s.title,
    status: s.status,
    shotCount: (s.shots || []).length,
    approvedBy: s.approvedBy || null,
  }));
  const blockers = [];
  if (scripts.length === 0) blockers.push("尚无剧本修订");
  else if (latest && latest.reviewStatus !== "APPROVED") blockers.push(`最新剧本未 APPROVED（${latest.reviewStatus}）`);
  if (!project.characters?.length) blockers.push("尚未 set-characters");
  if (!scenes.length) blockers.push("尚未 set-storyboard");
  else if (scenes.some((s) => s.status !== "APPROVED")) blockers.push("存在未 APPROVED 的场景");
  if (!project.voicePlan) blockers.push("尚未 voice-plan");
  else if (project.voicePlan.totals?.budgetCap === "待你授权" || project.voicePlan.totals?.currency === "待填") {
    blockers.push("voice-plan 费用上限/币种待授权填写");
  }
  return {
    projectId: project.id,
    title: project.title,
    premise: project.premise,
    genre: project.genre,
    audience: project.audience,
    episodeCount: project.episodeCount,
    source: project.source,
    stage: project.stage || null,
    updatedAt: project.updatedAt,
    scriptCount: scripts.length,
    latestScript: latest,
    scripts,
    characterCount: project.characters?.length || 0,
    characters: project.characters || [],
    scenes,
    voicePlan: project.voicePlan
      ? {
          status: project.voicePlan.status,
          totals: project.voicePlan.totals,
          nextHumanSteps: project.voicePlan.nextHumanSteps,
        }
      : null,
    blockers,
  };
}

function normalizeCharacters(characters) {
  if (typeof characters === "string") {
    const trimmed = characters.trim();
    if (!trimmed) return [];
    characters = JSON.parse(trimmed);
  }
  if (!Array.isArray(characters)) throw new Error("characters must be a JSON array");
  return characters.filter((c) => c && c.name);
}

function normalizeScene(scene) {
  if (typeof scene === "string") scene = JSON.parse(scene);
  if (!scene || typeof scene !== "object") throw new Error("scene must be a JSON object");
  const episodeNo = Number(scene.episodeNo || 1);
  const title = String(scene.title || `场景 ${episodeNo}`).trim();
  const id = scene.id || `scene-ep${episodeNo}-${slug(title)}`;
  const shots = Array.isArray(scene.shots)
    ? scene.shots.map((sh, i) => ({
        id: sh.id || `shot-${i + 1}`,
        n: Number(sh.n || i + 1),
        desc: String(sh.desc || "").trim(),
        durationHintSec: Number(sh.durationHintSec || sh.duration || 4),
        line: String(sh.line || "").trim(),
      }))
    : [];
  if (shots.length === 0) throw new Error("scene.shots required");
  return {
    id,
    episodeNo,
    title,
    status: scene.status || "DRAFT",
    shots,
  };
}

/** Parse "姓名：台词" / "姓名:台词" lines from script text. */
export function parseDialogueLines(text) {
  const map = new Map();
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(/^([^：:]{1,20})[：:](.+)$/);
    if (!m) continue;
    const name = m[1].trim();
    const dialogue = m[2].trim();
    if (!dialogue) continue;
    if (name.startsWith("场景") || name.startsWith("角色")) continue;
    if (!map.has(name)) map.set(name, []);
    map.get(name).push(dialogue);
  }
  return map;
}

function slug(name) {
  return String(name || "x")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9\u4e00-\u9fff-]/g, "")
    .slice(0, 32) || "x";
}

function simpleHash(text) {
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (Math.imul(31, h) + text.charCodeAt(i)) | 0;
  return `local:${(h >>> 0).toString(16)}:${text.length}`;
}
