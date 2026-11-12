import { isDeepStrictEqual } from "node:util";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { DomainError } from "./errors";

export const PRODUCTION_STATE_SCHEMA_VERSION = "hongguo-production-state.v1" as const;

export const PRODUCTION_VERSION_STATUSES = ["draft", "review", "revision", "locked"] as const;
export type ProductionVersionStatus = (typeof PRODUCTION_VERSION_STATUSES)[number];

const versionStatusSchema = z.enum(PRODUCTION_VERSION_STATUSES);
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/i);

const versionRefSchema = z.object({
  versionId: z.string().min(1),
  status: versionStatusSchema,
  path: z.string().optional(),
  sha256: sha256Schema.optional(),
  createdAt: z.string().optional(),
  lockedAt: z.string().optional(),
  lockedBy: z.literal("user").optional(),
  sourceQuote: z.string().optional(),
  supersedes: z.string().optional(),
}).passthrough();

const versionedArtifactSchema = z.object({
  currentVersionId: z.string().min(1),
  activeLockedVersionId: z.string().min(1).nullable(),
  versions: z.array(versionRefSchema),
}).passthrough();

const manifestCostSchema = z.union([z.number().nonnegative(), z.literal("unknown")]);

export const productionManifestSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
  prompt: z.string().nullable().optional(),
  promptLang: z.string().optional(),
  promptNote: z.string().optional(),
  referenceAssets: z.array(z.unknown()).optional(),
  seed: z.union([z.number(), z.string(), z.null()]).optional(),
  params: z.record(z.string(), z.unknown()).optional(),
  cost: manifestCostSchema,
  output: z.record(z.string(), z.unknown()).optional(),
  timestamp: z.string().nullable(),
  jobStatus: z.enum(["success", "failed", "unknown"]),
  sourceTask: z.string().optional(),
}).passthrough();

const takeSchema = z.object({
  takeId: z.string().min(1),
  index: z.number().int().min(1),
  status: z.enum(["not_selected", "selected", "discarded"]),
  modelPool: z.enum(["production", "experimental"]),
  note: z.string().optional(),
  manifest: productionManifestSchema,
}).passthrough();

const shotVersionSchema = z.object({
  versionId: z.string().min(1),
  status: versionStatusSchema,
  lockedAt: z.string().optional(),
  lockedBy: z.literal("user").optional(),
  sourceQuote: z.string().optional(),
  supersedes: z.string().optional(),
  selectedTakeId: z.string().min(1).nullable().optional(),
  takes: z.array(takeSchema),
}).passthrough();

const shotSchema = z.object({
  shotId: z.string().min(1),
  look: z.string().optional(),
  timelineStartSec: z.number().optional(),
  timelineEndSec: z.number().optional(),
  dialogueLineId: z.string().nullable().optional(),
  currentVersionId: z.string().min(1),
  activeLockedVersionId: z.string().min(1).nullable(),
  versions: z.array(shotVersionSchema),
}).passthrough();

const qaCheckSchema = z.object({
  result: z.enum(["pass", "fail", "not_scored"]),
  measured: z.unknown().optional(),
  expected: z.unknown().optional(),
  note: z.string().optional(),
}).strict();

const qaReportSchema = z.object({
  qaId: z.string().min(1),
  trackId: z.string().optional(),
  assemblyVersionId: z.string().optional(),
  result: z.enum(["pass", "fail", "pending"]),
  path: z.string().optional(),
  evidence: z.string().optional(),
  checkedAt: z.string().optional(),
  checkedBy: z.string().optional(),
  checks: z.object({
    visual: qaCheckSchema,
    audio: qaCheckSchema,
    subtitle: qaCheckSchema,
    duration: qaCheckSchema,
    resolution: qaCheckSchema,
    fps: qaCheckSchema,
    fileIntegrity: qaCheckSchema,
    shotOrder: qaCheckSchema,
    assetHash: qaCheckSchema,
  }).strict(),
}).passthrough();

const assemblySchema = z.object({
  trackId: z.string().min(1),
  label: z.string().optional(),
  currentVersionId: z.string().min(1),
  activeLockedVersionId: z.string().min(1).nullable(),
  versions: z.array(versionRefSchema),
}).passthrough();

const characterSchema = z.object({
  characterId: z.string().min(1),
  name: z.string().min(1),
  look: versionedArtifactSchema.optional(),
  voice: versionedArtifactSchema.optional(),
}).passthrough();

const budgetGateSchema = z.object({
  currency: z.string().nullable(),
  maxCostPerTake: z.number().nonnegative().nullable(),
  maxTakesPerShot: z.number().int().min(1).nullable(),
  maxExperimentalCostPerEpisode: z.number().nonnegative().nullable(),
  unknownCostRule: z.string().optional(),
  note: z.string().optional(),
}).strict();

const modelPolicyVersionSchema = z.object({
  policyVersion: z.string().min(1),
  effectiveAt: z.string().nullable(),
  approvedBy: z.literal("user").nullable(),
  status: versionStatusSchema,
  supersedes: z.string().nullable().optional(),
  production: z.record(z.string(), z.unknown()),
  experimental: z.object({
    enabled: z.boolean(),
    pool: z.array(z.string()),
    note: z.string().optional(),
  }).passthrough(),
  budget: budgetGateSchema,
  versionId: z.string().min(1).optional(),
}).strict();

const modelPolicySchema = z.object({
  currentVersionId: z.string().min(1),
  activeLockedVersionId: z.string().min(1).nullable(),
  versions: z.array(modelPolicyVersionSchema),
}).strict();

export const approvalEventSchema = z.object({
  eventId: z.string().min(1),
  action: z.enum(["submit_review", "request_revision", "select_take", "lock", "approve_policy"]),
  objectType: z.enum(["bible", "script", "look", "voice", "dialogue", "storyboard", "shot", "assembly", "modelPolicy", "qa"]),
  objectId: z.string().min(1),
  versionId: z.string().min(1),
  fromStatus: z.string().nullable(),
  toStatus: z.string().nullable(),
  actor: z.enum(["user", "director", "qa"]),
  sourceQuote: z.string().nullable().optional(),
  timestamp: z.string(),
  note: z.string().optional(),
}).strict();

const episodeSchema = z.object({
  episodeId: z.string().min(1),
  status: z.string().min(1),
  script: versionedArtifactSchema,
  dialogueTimeline: versionedArtifactSchema.nullable().optional(),
  storyboard: versionedArtifactSchema.nullable().optional(),
  shots: z.array(shotSchema),
  assemblies: z.array(assemblySchema),
  qa: z.array(qaReportSchema),
  retakeRequests: z.array(z.unknown()),
}).passthrough();

export const productionStateSchema = z.object({
  schema: z.literal(PRODUCTION_STATE_SCHEMA_VERSION),
  spec: z.string(),
  projectId: z.string().min(1),
  title: z.string().min(1),
  status: z.string().min(1),
  timezone: z.literal("Asia/Shanghai"),
  updatedAt: z.string(),
  backfill: z.boolean().optional(),
  notes: z.string().optional(),
  format: z.object({
    aspect: z.string(),
    resolution: z.string(),
    fps: z.number().positive(),
  }).strict(),
  modelPolicy: modelPolicySchema,
  approvalLog: z.array(approvalEventSchema),
  bible: versionedArtifactSchema,
  characters: z.array(characterSchema),
  episodes: z.array(episodeSchema),
}).strict();

export type ProductionManifest = z.infer<typeof productionManifestSchema>;
export type ApprovalEvent = z.infer<typeof approvalEventSchema>;
export type ProductionState = z.infer<typeof productionStateSchema>;
export type ProductionEpisode = ProductionState["episodes"][number];

export interface ProductionStateIssue {
  code: string;
  path: string;
  message: string;
}

export interface ProductionStateValidation {
  valid: boolean;
  issues: ProductionStateIssue[];
}

export interface ProductionGateBlocker {
  code: string;
  path: string;
  message: string;
  characterId?: string;
}

export interface ProductionGateResult {
  allowed: boolean;
  episodeId: string;
  blockers: ProductionGateBlocker[];
  visualCharacterIds: string[];
  voiceCharacterIds: string[];
}

type GenericVersion = {
  versionId: string;
  status: ProductionVersionStatus;
  supersedes?: string;
  [key: string]: unknown;
};

type GenericVersionContainer = {
  currentVersionId: string;
  activeLockedVersionId: string | null;
  versions: GenericVersion[];
};

type PolicyVersion = ProductionState["modelPolicy"]["versions"][number];

function productionStateError(code: string, message: string): DomainError {
  return new DomainError(code, message);
}

function issuePath(path: readonly PropertyKey[]): string {
  return path.map((item) => String(item)).join(".");
}

export function parseProductionManifest(input: unknown): ProductionManifest {
  const parsed = productionManifestSchema.safeParse(input);
  if (!parsed.success) {
    const summary = parsed.error.issues.slice(0, 5).map((issue) => issuePath(issue.path) + ": " + issue.message).join("; ");
    throw productionStateError("PRODUCTION_MANIFEST_INVALID", "Production manifest is invalid: " + summary);
  }
  return parsed.data;
}

export function parseProductionState(input: unknown): ProductionState {
  const parsed = productionStateSchema.safeParse(input);
  if (!parsed.success) {
    const summary = parsed.error.issues.slice(0, 8).map((issue) => issuePath(issue.path) + ": " + issue.message).join("; ");
    throw productionStateError("PRODUCTION_STATE_SCHEMA_INVALID", "Production state is invalid: " + summary);
  }
  return parsed.data;
}

export function parseProductionStateJson(input: string): ProductionState {
  let json: unknown;
  try {
    json = JSON.parse(input);
  } catch {
    throw productionStateError("PRODUCTION_STATE_JSON_INVALID", "Production state file is not valid JSON");
  }
  return parseProductionState(json);
}

function pushIssue(issues: ProductionStateIssue[], code: string, path: string, message: string): void {
  issues.push({ code, path, message });
}

function duplicateIds(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return [...duplicates];
}

function validateVersionContainer(
  container: GenericVersionContainer,
  path: string,
  issues: ProductionStateIssue[],
): void {
  const ids = container.versions.map((version) => version.versionId);
  for (const duplicate of duplicateIds(ids)) {
    pushIssue(issues, "VERSION_ID_DUPLICATE", path + ".versions", "Duplicate versionId: " + duplicate);
  }
  const byId = new Map(container.versions.map((version) => [version.versionId, version] as const));
  if (!byId.has(container.currentVersionId)) {
    pushIssue(issues, "CURRENT_VERSION_MISSING", path + ".currentVersionId", "currentVersionId does not exist in versions[]");
  }
  if (container.activeLockedVersionId !== null) {
    const active = byId.get(container.activeLockedVersionId);
    if (!active) {
      pushIssue(issues, "ACTIVE_LOCKED_VERSION_MISSING", path + ".activeLockedVersionId", "activeLockedVersionId does not exist in versions[]");
    } else if (active.status !== "locked") {
      pushIssue(issues, "ACTIVE_VERSION_NOT_LOCKED", path + ".activeLockedVersionId", "activeLockedVersionId must point to a locked version");
    }
  }

  for (const version of container.versions) {
    if (version.supersedes !== undefined && !byId.has(version.supersedes)) {
      pushIssue(issues, "SUPERSEDES_VERSION_MISSING", path + ".versions." + version.versionId + ".supersedes", "supersedes must point to a version in the same container");
    }
  }

  for (const version of container.versions) {
    const visited = new Set<string>();
    let cursor: GenericVersion | undefined = version;
    while (cursor?.supersedes !== undefined) {
      if (visited.has(cursor.versionId)) {
        pushIssue(issues, "SUPERSEDES_CYCLE", path + ".versions." + version.versionId, "supersedes chain contains a cycle");
        break;
      }
      visited.add(cursor.versionId);
      cursor = byId.get(cursor.supersedes);
      if (!cursor) break;
    }
  }
}

function policyVersionId(version: PolicyVersion): string {
  return version.policyVersion;
}

function validatePolicyContainer(state: ProductionState, issues: ProductionStateIssue[]): void {
  const path = "modelPolicy";
  const ids = state.modelPolicy.versions.map(policyVersionId);
  for (const duplicate of duplicateIds(ids)) {
    pushIssue(issues, "POLICY_VERSION_DUPLICATE", path + ".versions", "Duplicate policyVersion: " + duplicate);
  }
  const byId = new Map(state.modelPolicy.versions.map((version) => [policyVersionId(version), version] as const));
  if (!byId.has(state.modelPolicy.currentVersionId)) {
    pushIssue(issues, "CURRENT_POLICY_MISSING", path + ".currentVersionId", "currentVersionId does not match a policyVersion");
  }
  if (state.modelPolicy.activeLockedVersionId !== null) {
    const active = byId.get(state.modelPolicy.activeLockedVersionId);
    if (!active) {
      pushIssue(issues, "ACTIVE_POLICY_MISSING", path + ".activeLockedVersionId", "activeLockedVersionId does not match a policyVersion");
    } else if (active.status !== "locked") {
      pushIssue(issues, "ACTIVE_POLICY_NOT_LOCKED", path + ".activeLockedVersionId", "active model policy must be locked");
    }
  }

  const generic: GenericVersionContainer = {
    currentVersionId: state.modelPolicy.currentVersionId,
    activeLockedVersionId: state.modelPolicy.activeLockedVersionId,
    versions: state.modelPolicy.versions.map((version) => ({
      ...version,
      versionId: policyVersionId(version),
      supersedes: version.supersedes ?? undefined,
    })),
  };
  validateVersionContainer(generic, path, issues);

  for (const version of state.modelPolicy.versions) {
    if (version.status !== "locked") continue;
    const base = path + ".versions." + version.policyVersion;
    if (version.approvedBy !== "user") {
      pushIssue(issues, "LOCKED_POLICY_NOT_USER_APPROVED", base + ".approvedBy", "locked modelPolicy must be approved by user");
    }
    if (version.effectiveAt === null) {
      pushIssue(issues, "LOCKED_POLICY_EFFECTIVE_AT_MISSING", base + ".effectiveAt", "locked modelPolicy requires effectiveAt");
    }
    if (version.budget.currency === null
      || version.budget.maxCostPerTake === null
      || version.budget.maxTakesPerShot === null
      || version.budget.maxExperimentalCostPerEpisode === null) {
      pushIssue(issues, "LOCKED_POLICY_BUDGET_INCOMPLETE", base + ".budget", "locked modelPolicy requires all budget gates");
    }
  }
}

function validateApprovalActors(state: ProductionState, issues: ProductionStateIssue[]): void {
  const ids = state.approvalLog.map((event) => event.eventId);
  for (const duplicate of duplicateIds(ids)) {
    pushIssue(issues, "APPROVAL_EVENT_DUPLICATE", "approvalLog", "Duplicate ApprovalEvent eventId: " + duplicate);
  }
  for (const event of state.approvalLog) {
    const path = "approvalLog." + event.eventId + ".actor";
    if (event.action === "submit_review" && event.actor !== "director") {
      pushIssue(issues, "APPROVAL_ACTOR_INVALID", path, "submit_review must be recorded by director");
    }
    if (event.action !== "submit_review" && event.actor !== "user") {
      pushIssue(issues, "APPROVAL_ACTOR_INVALID", path, event.action + " must be confirmed by user");
    }
  }
}

function validateShot(shot: ProductionEpisode["shots"][number], path: string, issues: ProductionStateIssue[]): void {
  validateVersionContainer(shot as unknown as GenericVersionContainer, path, issues);
  for (const version of shot.versions) {
    const versionPath = path + ".versions." + version.versionId;
    const takeIds = version.takes.map((take) => take.takeId);
    for (const duplicate of duplicateIds(takeIds)) {
      pushIssue(issues, "TAKE_ID_DUPLICATE", versionPath + ".takes", "Duplicate takeId: " + duplicate);
    }

    const selectedTakes = version.takes.filter((take) => take.status === "selected");
    if (selectedTakes.length > 1) {
      pushIssue(issues, "MULTIPLE_SELECTED_TAKES", versionPath + ".takes", "At most one Take may be selected");
    }

    if (version.selectedTakeId === null || version.selectedTakeId === undefined) {
      if (selectedTakes.length > 0) {
        pushIssue(issues, "SELECTED_TAKE_POINTER_MISSING", versionPath + ".selectedTakeId", "selected Take requires selectedTakeId");
      }
      if (version.status === "locked") {
        pushIssue(issues, "LOCKED_SHOT_TAKE_MISSING", versionPath + ".selectedTakeId", "locked ShotVersion requires a selected production Take");
      }
      continue;
    }

    const selected = version.takes.find((take) => take.takeId === version.selectedTakeId);
    if (!selected) {
      pushIssue(issues, "SELECTED_TAKE_MISSING", versionPath + ".selectedTakeId", "selectedTakeId does not exist in takes[]");
      continue;
    }
    if (selected.status !== "selected") {
      pushIssue(issues, "SELECTED_TAKE_STATUS_INVALID", versionPath + ".selectedTakeId", "selectedTakeId must point to a Take with status=selected");
    }
    if (version.status === "locked" && selected.modelPool !== "production") {
      pushIssue(issues, "LOCKED_SHOT_EXPERIMENTAL_TAKE", versionPath + ".selectedTakeId", "locked ShotVersion must select a production Take");
    }
  }
}

export function validateProductionStateSemantics(state: ProductionState): ProductionStateValidation {
  const issues: ProductionStateIssue[] = [];
  validateVersionContainer(state.bible as GenericVersionContainer, "bible", issues);
  validatePolicyContainer(state, issues);
  validateApprovalActors(state, issues);

  for (const duplicate of duplicateIds(state.characters.map((character) => character.characterId))) {
    pushIssue(issues, "CHARACTER_ID_DUPLICATE", "characters", "Duplicate characterId: " + duplicate);
  }
  for (const character of state.characters) {
    if (character.look) validateVersionContainer(character.look as GenericVersionContainer, "characters." + character.characterId + ".look", issues);
    if (character.voice) validateVersionContainer(character.voice as GenericVersionContainer, "characters." + character.characterId + ".voice", issues);
  }

  for (const duplicate of duplicateIds(state.episodes.map((episode) => episode.episodeId))) {
    pushIssue(issues, "EPISODE_ID_DUPLICATE", "episodes", "Duplicate episodeId: " + duplicate);
  }
  for (const episode of state.episodes) {
    const base = "episodes." + episode.episodeId;
    validateVersionContainer(episode.script as GenericVersionContainer, base + ".script", issues);
    if (episode.dialogueTimeline) validateVersionContainer(episode.dialogueTimeline as GenericVersionContainer, base + ".dialogueTimeline", issues);
    if (episode.storyboard) validateVersionContainer(episode.storyboard as GenericVersionContainer, base + ".storyboard", issues);

    for (const duplicate of duplicateIds(episode.shots.map((shot) => shot.shotId))) {
      pushIssue(issues, "SHOT_ID_DUPLICATE", base + ".shots", "Duplicate shotId: " + duplicate);
    }
    for (const shot of episode.shots) validateShot(shot, base + ".shots." + shot.shotId, issues);

    for (const duplicate of duplicateIds(episode.assemblies.map((assembly) => assembly.trackId))) {
      pushIssue(issues, "ASSEMBLY_TRACK_DUPLICATE", base + ".assemblies", "Duplicate trackId: " + duplicate);
    }
    for (const assembly of episode.assemblies) {
      validateVersionContainer(assembly as unknown as GenericVersionContainer, base + ".assemblies." + assembly.trackId, issues);
    }

    for (const qa of episode.qa) {
      if (qa.result === "pass" && Object.values(qa.checks).some((check) => check.result === "fail")) {
        pushIssue(issues, "QA_PASS_CONTAINS_FAILURE", base + ".qa." + qa.qaId, "QA result=pass cannot contain a failed check");
      }
    }
  }

  return { valid: issues.length === 0, issues };
}

export function assertProductionStateSemantics(state: ProductionState): void {
  const result = validateProductionStateSemantics(state);
  if (result.valid) return;
  const summary = result.issues.slice(0, 8).map((issue) => issue.path + ": " + issue.message).join("; ");
  throw productionStateError("PRODUCTION_STATE_SEMANTIC_INVALID", summary);
}

function activeOrCurrentVersion(container: GenericVersionContainer): GenericVersion | null {
  const id = container.activeLockedVersionId ?? container.currentVersionId;
  return container.versions.find((version) => version.versionId === id) ?? null;
}

function stringIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function addReferencedIds(version: GenericVersion | null, target: Set<string>): void {
  if (!version) return;
  for (const id of stringIds(version.referencedCharacterIds)) target.add(id);
  for (const id of stringIds(version.characterIds)) target.add(id);
}

function blocker(blockers: ProductionGateBlocker[], code: string, path: string, message: string, characterId?: string): void {
  blockers.push({ code, path, message, ...(characterId ? { characterId } : {}) });
}

export function productionReadiness(state: ProductionState, episodeId: string): ProductionGateResult {
  const episode = state.episodes.find((item) => item.episodeId === episodeId);
  if (!episode) throw productionStateError("PRODUCTION_EPISODE_NOT_FOUND", "Episode not found: " + episodeId);

  const blockers: ProductionGateBlocker[] = [];
  const visualCharacterIds = new Set<string>();
  const voiceCharacterIds = new Set<string>();

  if (state.bible.activeLockedVersionId === null) {
    blocker(blockers, "BIBLE_LOCK_MISSING", "bible.activeLockedVersionId", "Series bible has no active locked version");
  }
  if (episode.script.activeLockedVersionId === null) {
    blocker(blockers, "SCRIPT_LOCK_MISSING", "episodes." + episodeId + ".script.activeLockedVersionId", "Episode script has no active locked version");
  }
  if (!episode.dialogueTimeline || episode.dialogueTimeline.activeLockedVersionId === null) {
    blocker(blockers, "DIALOGUE_LOCK_MISSING", "episodes." + episodeId + ".dialogueTimeline.activeLockedVersionId", "Dialogue timeline has no active locked version");
  }
  if (state.modelPolicy.activeLockedVersionId === null) {
    blocker(blockers, "MODEL_POLICY_LOCK_MISSING", "modelPolicy.activeLockedVersionId", "Model policy has no active locked version");
  }

  addReferencedIds(activeOrCurrentVersion(episode.script as GenericVersionContainer), visualCharacterIds);
  if (episode.storyboard) addReferencedIds(activeOrCurrentVersion(episode.storyboard as GenericVersionContainer), visualCharacterIds);

  const dialogueVersion = episode.dialogueTimeline
    ? activeOrCurrentVersion(episode.dialogueTimeline as GenericVersionContainer)
    : null;
  const lines = dialogueVersion && Array.isArray(dialogueVersion.lines) ? dialogueVersion.lines : [];
  for (const line of lines) {
    if (!line || typeof line !== "object") continue;
    const record = line as Record<string, unknown>;
    if (typeof record.characterId === "string") {
      voiceCharacterIds.add(record.characterId);
      continue;
    }
    if (typeof record.role === "string") {
      const matches = state.characters.filter((character) => character.name === record.role);
      if (matches.length === 1) voiceCharacterIds.add(matches[0]!.characterId);
      else blocker(
        blockers,
        "DIALOGUE_ROLE_UNRESOLVED",
        "episodes." + episodeId + ".dialogueTimeline.lines",
        "Dialogue role must match exactly one Character.name: " + record.role,
      );
    }
  }

  for (const shot of episode.shots) {
    if (shot.look && state.characters.some((character) => character.characterId === shot.look)) {
      visualCharacterIds.add(shot.look);
    }
  }

  const byId = new Map(state.characters.map((character) => [character.characterId, character] as const));
  for (const characterId of visualCharacterIds) {
    const character = byId.get(characterId);
    if (!character) {
      blocker(blockers, "CHARACTER_MISSING", "characters", "Referenced character does not exist: " + characterId, characterId);
      continue;
    }
    if (!character.look || character.look.activeLockedVersionId === null) {
      blocker(blockers, "CHARACTER_LOOK_LOCK_MISSING", "characters." + characterId + ".look.activeLockedVersionId", "Referenced visual character has no active locked Look", characterId);
    }
  }
  for (const characterId of voiceCharacterIds) {
    const character = byId.get(characterId);
    if (!character) {
      blocker(blockers, "CHARACTER_MISSING", "characters", "Referenced dialogue character does not exist: " + characterId, characterId);
      continue;
    }
    if (!character.voice || character.voice.activeLockedVersionId === null) {
      blocker(blockers, "CHARACTER_VOICE_LOCK_MISSING", "characters." + characterId + ".voice.activeLockedVersionId", "Referenced dialogue character has no active locked Voice", characterId);
    }
  }

  return {
    allowed: blockers.length === 0,
    episodeId,
    blockers,
    visualCharacterIds: [...visualCharacterIds].sort(),
    voiceCharacterIds: [...voiceCharacterIds].sort(),
  };
}

export function assertFormalProductionAllowed(state: ProductionState, episodeId: string): void {
  const result = productionReadiness(state, episodeId);
  if (result.allowed) return;
  throw productionStateError(
    "PRODUCTION_GATE_BLOCKED",
    result.blockers.map((item) => item.code + "@" + item.path).join(", "),
  );
}


export interface TakeGenerationGateRequest {
  episodeId: string;
  shotId: string;
  shotVersionId: string;
  modelPool: "production" | "experimental";
  capability: string;
  model: string;
  estimatedCost: number | "unknown";
  allowUnknownCost?: boolean;
}

export interface TakeGenerationGateResult {
  allowed: boolean;
  blockers: ProductionGateBlocker[];
}

export function takeGenerationReadiness(
  state: ProductionState,
  request: TakeGenerationGateRequest,
): TakeGenerationGateResult {
  const blockers = [...productionReadiness(state, request.episodeId).blockers];
  const episode = state.episodes.find((item) => item.episodeId === request.episodeId);
  if (!episode) throw productionStateError("PRODUCTION_EPISODE_NOT_FOUND", "Episode not found: " + request.episodeId);
  const shot = episode.shots.find((item) => item.shotId === request.shotId);
  if (!shot) throw productionStateError("PRODUCTION_SHOT_NOT_FOUND", "Shot not found: " + request.shotId);
  const shotVersion = shot.versions.find((item) => item.versionId === request.shotVersionId);
  if (!shotVersion) throw productionStateError("PRODUCTION_SHOT_VERSION_NOT_FOUND", "ShotVersion not found: " + request.shotVersionId);

  const activePolicy = state.modelPolicy.activeLockedVersionId === null
    ? null
    : state.modelPolicy.versions.find((version) => version.policyVersion === state.modelPolicy.activeLockedVersionId) ?? null;
  if (!activePolicy) {
    blocker(blockers, "MODEL_POLICY_LOCK_MISSING", "modelPolicy.activeLockedVersionId", "Take generation requires an active locked modelPolicy");
    return { allowed: false, blockers };
  }

  const budget = activePolicy.budget;
  if (budget.maxTakesPerShot !== null && shotVersion.takes.length >= budget.maxTakesPerShot) {
    blocker(
      blockers,
      "MAX_TAKES_PER_SHOT_REACHED",
      "episodes." + request.episodeId + ".shots." + request.shotId + ".versions." + request.shotVersionId + ".takes",
      "Take count has reached the active modelPolicy limit",
    );
  }

  if (request.estimatedCost === "unknown") {
    if (!request.allowUnknownCost) {
      blocker(blockers, "UNKNOWN_COST_REQUIRES_APPROVAL", "modelPolicy.budget", "Unknown generation cost requires explicit user approval");
    }
  } else if (budget.maxCostPerTake !== null && request.estimatedCost > budget.maxCostPerTake) {
    blocker(blockers, "MAX_COST_PER_TAKE_EXCEEDED", "modelPolicy.budget.maxCostPerTake", "Estimated Take cost exceeds the active policy limit");
  }

  if (request.modelPool === "production") {
    const expected = activePolicy.production[request.capability];
    if (typeof expected !== "string") {
      blocker(blockers, "PRODUCTION_MODEL_BINDING_MISSING", "modelPolicy.production." + request.capability, "No production model is bound for this capability");
    } else if (expected !== request.model) {
      blocker(blockers, "PRODUCTION_MODEL_MISMATCH", "modelPolicy.production." + request.capability, "Requested model does not match the locked production model");
    }
  } else {
    if (!activePolicy.experimental.enabled) {
      blocker(blockers, "EXPERIMENTAL_POOL_DISABLED", "modelPolicy.experimental.enabled", "Experimental model pool is disabled");
    }
    if (!activePolicy.experimental.pool.includes(request.model)) {
      blocker(blockers, "EXPERIMENTAL_MODEL_NOT_ALLOWED", "modelPolicy.experimental.pool", "Requested experimental model is not in the whitelist");
    }

    let recordedCost = 0;
    let unknownRecordedCost = false;
    for (const item of episode.shots) {
      for (const version of item.versions) {
        for (const take of version.takes) {
          if (take.modelPool !== "experimental") continue;
          if (take.manifest.cost === "unknown") unknownRecordedCost = true;
          else recordedCost += take.manifest.cost;
        }
      }
    }
    if (unknownRecordedCost && !request.allowUnknownCost) {
      blocker(blockers, "EXPERIMENTAL_COST_UNKNOWN", "modelPolicy.budget.maxExperimentalCostPerEpisode", "Existing experimental cost is unknown and requires user approval");
    }
    if (request.estimatedCost !== "unknown" && budget.maxExperimentalCostPerEpisode !== null
      && recordedCost + request.estimatedCost > budget.maxExperimentalCostPerEpisode) {
      blocker(blockers, "EXPERIMENTAL_EPISODE_BUDGET_EXCEEDED", "modelPolicy.budget.maxExperimentalCostPerEpisode", "Experimental episode budget would be exceeded");
    }
  }

  return { allowed: blockers.length === 0, blockers };
}

export function assertTakeGenerationAllowed(state: ProductionState, request: TakeGenerationGateRequest): void {
  const result = takeGenerationReadiness(state, request);
  if (result.allowed) return;
  throw productionStateError(
    "TAKE_GENERATION_BLOCKED",
    result.blockers.map((item) => item.code + "@" + item.path).join(", "),
  );
}

export function appendApprovalEvent(state: ProductionState, eventInput: unknown): ProductionState {
  const event = approvalEventSchema.parse(eventInput);
  if (state.approvalLog.some((item) => item.eventId === event.eventId)) {
    throw productionStateError("APPROVAL_EVENT_DUPLICATE", "ApprovalEvent already exists: " + event.eventId);
  }
  const next = cloneState(state);
  next.approvalLog.push(event);
  next.updatedAt = event.timestamp;
  return next;
}

function cloneState<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function findCharacter(state: ProductionState, characterId: string) {
  return state.characters.find((character) => character.characterId === characterId);
}

function findEpisode(state: ProductionState, episodeId: string) {
  return state.episodes.find((episode) => episode.episodeId === episodeId);
}

function assertApprovalLogAppendOnly(previous: ProductionState, next: ProductionState): ApprovalEvent[] {
  if (next.approvalLog.length < previous.approvalLog.length) {
    throw productionStateError("APPROVAL_LOG_REWRITE_FORBIDDEN", "ApprovalLog cannot delete existing events");
  }
  for (let index = 0; index < previous.approvalLog.length; index += 1) {
    if (!isDeepStrictEqual(previous.approvalLog[index], next.approvalLog[index])) {
      throw productionStateError("APPROVAL_LOG_REWRITE_FORBIDDEN", "ApprovalLog is append-only");
    }
  }
  return next.approvalLog.slice(previous.approvalLog.length);
}

function assertLockedContainerPreserved(
  previous: GenericVersionContainer | undefined,
  next: GenericVersionContainer | undefined,
  path: string,
): void {
  if (!previous) return;
  const locked = previous.versions.filter((version) => version.status === "locked");
  if (locked.length === 0) return;
  if (!next) throw productionStateError("LOCKED_VERSION_DELETE_FORBIDDEN", "Cannot remove locked container: " + path);
  const byId = new Map(next.versions.map((version) => [version.versionId, version] as const));
  for (const version of locked) {
    const candidate = byId.get(version.versionId);
    if (!candidate) throw productionStateError("LOCKED_VERSION_DELETE_FORBIDDEN", "Cannot remove locked version: " + path + "/" + version.versionId);
    if (!isDeepStrictEqual(version, candidate)) {
      throw productionStateError("LOCKED_VERSION_REWRITE_FORBIDDEN", "Cannot modify locked version: " + path + "/" + version.versionId);
    }
  }
}

function policyAsGeneric(container: ProductionState["modelPolicy"]): GenericVersionContainer {
  return {
    currentVersionId: container.currentVersionId,
    activeLockedVersionId: container.activeLockedVersionId,
    versions: container.versions.map((version) => ({
      ...version,
      versionId: version.policyVersion,
      supersedes: version.supersedes ?? undefined,
    })),
  };
}

function hasNewApproval(
  events: readonly ApprovalEvent[],
  action: ApprovalEvent["action"],
  objectType: ApprovalEvent["objectType"],
  objectId: string,
  versionId: string,
): boolean {
  return events.some((event) =>
    event.action === action
    && event.objectType === objectType
    && event.objectId === objectId
    && event.versionId === versionId
    && event.actor === "user",
  );
}

function assertActivePointerChange(
  previousId: string | null,
  nextId: string | null,
  events: readonly ApprovalEvent[],
  action: ApprovalEvent["action"],
  objectType: ApprovalEvent["objectType"],
  objectId: string,
  path: string,
): void {
  if (previousId === nextId) return;
  if (nextId === null) {
    throw productionStateError("ACTIVE_LOCK_CLEAR_FORBIDDEN", "Cannot clear active locked pointer: " + path);
  }
  if (!hasNewApproval(events, action, objectType, objectId, nextId)) {
    throw productionStateError("APPROVAL_EVENT_REQUIRED", "Active locked pointer change requires a user ApprovalEvent: " + path);
  }
}

export function assertProductionStateUpdate(previous: ProductionState, next: ProductionState): void {
  if (previous.schema !== next.schema || previous.projectId !== next.projectId) {
    throw productionStateError("PRODUCTION_STATE_IDENTITY_MISMATCH", "schema and projectId are immutable");
  }

  const newEvents = assertApprovalLogAppendOnly(previous, next);

  assertLockedContainerPreserved(previous.bible as GenericVersionContainer, next.bible as GenericVersionContainer, "bible");
  assertActivePointerChange(
    previous.bible.activeLockedVersionId,
    next.bible.activeLockedVersionId,
    newEvents,
    "lock",
    "bible",
    next.projectId,
    "bible.activeLockedVersionId",
  );

  for (const previousCharacter of previous.characters) {
    const nextCharacter = findCharacter(next, previousCharacter.characterId);
    if (previousCharacter.look) {
      assertLockedContainerPreserved(
        previousCharacter.look as GenericVersionContainer,
        nextCharacter?.look as GenericVersionContainer | undefined,
        "characters." + previousCharacter.characterId + ".look",
      );
      if (nextCharacter?.look) {
        assertActivePointerChange(
          previousCharacter.look.activeLockedVersionId,
          nextCharacter.look.activeLockedVersionId,
          newEvents,
          "lock",
          "look",
          previousCharacter.characterId,
          "characters." + previousCharacter.characterId + ".look.activeLockedVersionId",
        );
      }
    }
    if (previousCharacter.voice) {
      assertLockedContainerPreserved(
        previousCharacter.voice as GenericVersionContainer,
        nextCharacter?.voice as GenericVersionContainer | undefined,
        "characters." + previousCharacter.characterId + ".voice",
      );
      if (nextCharacter?.voice) {
        assertActivePointerChange(
          previousCharacter.voice.activeLockedVersionId,
          nextCharacter.voice.activeLockedVersionId,
          newEvents,
          "lock",
          "voice",
          previousCharacter.characterId,
          "characters." + previousCharacter.characterId + ".voice.activeLockedVersionId",
        );
      }
    }
  }

  for (const previousEpisode of previous.episodes) {
    const nextEpisode = findEpisode(next, previousEpisode.episodeId);
    assertLockedContainerPreserved(
      previousEpisode.script as GenericVersionContainer,
      nextEpisode?.script as GenericVersionContainer | undefined,
      "episodes." + previousEpisode.episodeId + ".script",
    );
    if (nextEpisode) {
      assertActivePointerChange(
        previousEpisode.script.activeLockedVersionId,
        nextEpisode.script.activeLockedVersionId,
        newEvents,
        "lock",
        "script",
        previousEpisode.episodeId,
        "episodes." + previousEpisode.episodeId + ".script.activeLockedVersionId",
      );
    }

    if (previousEpisode.dialogueTimeline) {
      assertLockedContainerPreserved(
        previousEpisode.dialogueTimeline as GenericVersionContainer,
        nextEpisode?.dialogueTimeline as GenericVersionContainer | undefined,
        "episodes." + previousEpisode.episodeId + ".dialogueTimeline",
      );
      if (nextEpisode?.dialogueTimeline) {
        assertActivePointerChange(
          previousEpisode.dialogueTimeline.activeLockedVersionId,
          nextEpisode.dialogueTimeline.activeLockedVersionId,
          newEvents,
          "lock",
          "dialogue",
          previousEpisode.episodeId,
          "episodes." + previousEpisode.episodeId + ".dialogueTimeline.activeLockedVersionId",
        );
      }
    }

    if (previousEpisode.storyboard) {
      assertLockedContainerPreserved(
        previousEpisode.storyboard as GenericVersionContainer,
        nextEpisode?.storyboard as GenericVersionContainer | undefined,
        "episodes." + previousEpisode.episodeId + ".storyboard",
      );
      if (nextEpisode?.storyboard) {
        assertActivePointerChange(
          previousEpisode.storyboard.activeLockedVersionId,
          nextEpisode.storyboard.activeLockedVersionId,
          newEvents,
          "lock",
          "storyboard",
          previousEpisode.episodeId,
          "episodes." + previousEpisode.episodeId + ".storyboard.activeLockedVersionId",
        );
      }
    }

    for (const previousShot of previousEpisode.shots) {
      const nextShot = nextEpisode?.shots.find((shot) => shot.shotId === previousShot.shotId);
      assertLockedContainerPreserved(
        previousShot as unknown as GenericVersionContainer,
        nextShot as unknown as GenericVersionContainer | undefined,
        "episodes." + previousEpisode.episodeId + ".shots." + previousShot.shotId,
      );
      if (!nextShot) continue;
      assertActivePointerChange(
        previousShot.activeLockedVersionId,
        nextShot.activeLockedVersionId,
        newEvents,
        "lock",
        "shot",
        previousShot.shotId,
        "episodes." + previousEpisode.episodeId + ".shots." + previousShot.shotId + ".activeLockedVersionId",
      );

      for (const previousVersion of previousShot.versions) {
        const nextVersion = nextShot.versions.find((version) => version.versionId === previousVersion.versionId);
        if (!nextVersion || previousVersion.selectedTakeId === nextVersion.selectedTakeId) continue;
        if (nextVersion.selectedTakeId === null || nextVersion.selectedTakeId === undefined) {
          throw productionStateError("SELECTED_TAKE_CLEAR_FORBIDDEN", "Cannot clear selectedTakeId once selected");
        }
        if (!hasNewApproval(newEvents, "select_take", "shot", previousShot.shotId, previousVersion.versionId)) {
          throw productionStateError("APPROVAL_EVENT_REQUIRED", "Selecting a Take requires a user ApprovalEvent");
        }
      }
    }

    for (const previousAssembly of previousEpisode.assemblies) {
      const nextAssembly = nextEpisode?.assemblies.find((assembly) => assembly.trackId === previousAssembly.trackId);
      assertLockedContainerPreserved(
        previousAssembly as unknown as GenericVersionContainer,
        nextAssembly as unknown as GenericVersionContainer | undefined,
        "episodes." + previousEpisode.episodeId + ".assemblies." + previousAssembly.trackId,
      );
      if (nextAssembly) {
        assertActivePointerChange(
          previousAssembly.activeLockedVersionId,
          nextAssembly.activeLockedVersionId,
          newEvents,
          "lock",
          "assembly",
          previousAssembly.trackId,
          "episodes." + previousEpisode.episodeId + ".assemblies." + previousAssembly.trackId + ".activeLockedVersionId",
        );
      }
    }
  }

  assertLockedContainerPreserved(policyAsGeneric(previous.modelPolicy), policyAsGeneric(next.modelPolicy), "modelPolicy");
  assertActivePointerChange(
    previous.modelPolicy.activeLockedVersionId,
    next.modelPolicy.activeLockedVersionId,
    newEvents,
    "approve_policy",
    "modelPolicy",
    next.projectId,
    "modelPolicy.activeLockedVersionId",
  );
}

export async function readProductionStateFile(filePath: string): Promise<ProductionState> {
  const raw = await readFile(filePath, "utf8");
  const state = parseProductionStateJson(raw);
  assertProductionStateSemantics(state);
  return state;
}

export async function writeProductionStateFile(filePath: string, input: unknown): Promise<ProductionState> {
  const next = parseProductionState(input);
  assertProductionStateSemantics(next);

  let previous: ProductionState | null = null;
  try {
    previous = await readProductionStateFile(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (previous) assertProductionStateUpdate(previous, next);

  await mkdir(dirname(filePath), { recursive: true });
  const temporaryPath = filePath + ".tmp-" + String(process.pid) + "-" + String(Date.now());
  await writeFile(temporaryPath, JSON.stringify(next, null, 2) + "\n", { encoding: "utf8", flag: "wx" });
  await rename(temporaryPath, filePath);
  return next;
}
