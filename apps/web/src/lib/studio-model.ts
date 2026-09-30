export const LIMITS = {
  title: 200,
  premise: 4000,
  name: 200,
  heading: 400,
  timeOfDay: 100,
  summary: 4000,
  shotType: 100,
  camera: 1000,
  action: 4000,
  dialogue: 4000,
  durationHint: 200,
  promptText: 8000,
  reviewNote: 4000,
} as const;

export const TERMINAL_WORKFLOW_STATES = new Set([
  "SUCCEEDED",
  "PARTIAL_FAILED",
  "FAILED",
  "CANCELED",
]);

export const TEXT_WORKFLOW_TYPES = new Set(["MOCK_TEXT_SCENES", "MOCK_TEXT_SHOTS"]);

const REVIEW_NEXT: Record<string, readonly string[]> = {
  DRAFT: ["IN_REVIEW"],
  IN_REVIEW: ["APPROVED", "REJECTED"],
  APPROVED: [],
  REJECTED: [],
};

export interface ReviewAction {
  to: "IN_REVIEW" | "APPROVED" | "REJECTED";
  label: string;
  enabled: boolean;
  reason: string;
}

export function reviewActions(input: {
  reviewStatus: string;
  freshnessStatus: string;
  isCurrent: boolean;
}): ReviewAction[] {
  const catalog: Array<{ to: ReviewAction["to"]; label: string }> = [
    { to: "IN_REVIEW", label: "提交审核" },
    { to: "APPROVED", label: "通过" },
    { to: "REJECTED", label: "退回" },
  ];
  return catalog.map((action) => {
    if (input.freshnessStatus === "STALE") {
      return { ...action, enabled: false, reason: "新鲜度为 STALE，前端不能清除，审核不可用" };
    }
    if (!input.isCurrent) {
      return { ...action, enabled: false, reason: "只能审核当前版本" };
    }
    const allowed = REVIEW_NEXT[input.reviewStatus] ?? [];
    if (!allowed.includes(action.to)) {
      return {
        ...action,
        enabled: false,
        reason: `${input.reviewStatus} 不能转为 ${action.to}`,
      };
    }
    return { ...action, enabled: true, reason: "" };
  });
}

export type AggregateKind =
  | "story"
  | "script"
  | "character-create"
  | "location-create"
  | "character"
  | "location"
  | "scene-create"
  | "scene"
  | "shot-create"
  | "shot";

export function aggregateVersion(kind: AggregateKind, source: {
  projectVersion?: number;
  episodeRowVersion?: number;
  entityRowVersion?: number;
}): number {
  switch (kind) {
    case "story":
    case "character-create":
    case "location-create":
      if (source.projectVersion === undefined) throw new Error("missing project version");
      return source.projectVersion;
    case "script":
    case "scene-create":
      if (source.episodeRowVersion === undefined) throw new Error("missing episode version");
      return source.episodeRowVersion;
    case "character":
    case "location":
    case "scene":
    case "shot-create":
    case "shot":
      if (source.entityRowVersion === undefined) throw new Error("missing entity version");
      return source.entityRowVersion;
    default: {
      const neverKind: never = kind;
      return neverKind;
    }
  }
}

export function reviewRequest(revision: { reviewVersion: number }, to: string, reviewNote: string) {
  return {
    to,
    expectedReviewVersion: revision.reviewVersion,
    ...(reviewNote.trim().length > 0 ? { reviewNote: reviewNote.trim() } : {}),
  };
}

export function isSimpleContent(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value as Record<string, unknown>);
  return keys.every((key) => key === "text");
}

export function textOf(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  const text = (value as Record<string, unknown>).text;
  return typeof text === "string" ? text : "";
}

export function applyTextContent(existing: unknown, text: string): Record<string, unknown> {
  const base =
    existing && typeof existing === "object" && !Array.isArray(existing)
      ? { ...(existing as Record<string, unknown>) }
      : {};
  return { ...base, text };
}

export function parseContentObject(raw: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("正文必须是 JSON 对象");
  }
  return { ...(parsed as Record<string, unknown>) };
}

export interface LineChange {
  kind: "same" | "add" | "del";
  text: string;
}

export function lineDiff(before: string, after: string): LineChange[] {
  const left = before.split("\n");
  const right = after.split("\n");
  const dp: number[][] = Array.from({ length: left.length + 1 }, () => Array<number>(right.length + 1).fill(0));
  for (let i = left.length - 1; i >= 0; i -= 1) {
    const leftRow = dp[i];
    const nextRow = dp[i + 1];
    if (!leftRow || !nextRow) continue;
    for (let j = right.length - 1; j >= 0; j -= 1) {
      leftRow[j] = left[i] === right[j] ? (nextRow[j + 1] ?? 0) + 1 : Math.max(nextRow[j] ?? 0, leftRow[j + 1] ?? 0);
    }
  }
  const changes: LineChange[] = [];
  let i = 0;
  let j = 0;
  while (i < left.length && j < right.length) {
    if (left[i] === right[j]) {
      changes.push({ kind: "same", text: left[i] ?? "" });
      i += 1;
      j += 1;
    } else if ((dp[i + 1]?.[j] ?? 0) >= (dp[i]?.[j + 1] ?? 0)) {
      changes.push({ kind: "del", text: left[i] ?? "" });
      i += 1;
    } else {
      changes.push({ kind: "add", text: right[j] ?? "" });
      j += 1;
    }
  }
  while (i < left.length) {
    changes.push({ kind: "del", text: left[i] ?? "" });
    i += 1;
  }
  while (j < right.length) {
    changes.push({ kind: "add", text: right[j] ?? "" });
    j += 1;
  }
  return changes.filter((change) => change.kind !== "same");
}

export interface FieldDiff {
  path: string;
  change: "added" | "removed" | "changed";
  before: string;
  after: string;
  lines: LineChange[];
}

export function diffJson(before: unknown, after: unknown): FieldDiff[] {
  const rows: FieldDiff[] = [];
  walk(before, after, "", rows);
  return rows;
}

function walk(before: unknown, after: unknown, path: string, rows: FieldDiff[]): void {
  if (sameValue(before, after)) return;
  if (isPlainObject(before) && isPlainObject(after)) {
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort((a, b) => a.localeCompare(b));
    for (const key of keys) {
      walk(before[key], after[key], path ? `${path}.${key}` : key, rows);
    }
    return;
  }
  if (Array.isArray(before) && Array.isArray(after)) {
    const length = Math.max(before.length, after.length);
    for (let index = 0; index < length; index += 1) {
      walk(before[index], after[index], `${path}[${index}]`, rows);
    }
    return;
  }
  const beforeText = before === undefined ? "" : stringifyValue(before);
  const afterText = after === undefined ? "" : stringifyValue(after);
  rows.push({
    path: path || "$",
    change: before === undefined ? "added" : after === undefined ? "removed" : "changed",
    before: beforeText,
    after: afterText,
    lines: typeof before === "string" || typeof after === "string" ? lineDiff(String(before ?? ""), String(after ?? "")) : [],
  });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function sameValue(before: unknown, after: unknown): boolean {
  if (before === after) return true;
  if (Array.isArray(before) || Array.isArray(after) || isPlainObject(before) || isPlainObject(after)) {
    return stableJson(before) === stableJson(after);
  }
  return false;
}

export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(",")}]`;
  if (isPlainObject(value)) {
    const entries = Object.entries(value).sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function stringifyValue(value: unknown): string {
  return typeof value === "string" ? value : stableJson(value);
}

export interface DraftRecord {
  fingerprint: string;
  idempotencyKey: string;
  ifMatch: number | null;
  payload: unknown;
}

export function draftStorageKey(projectId: string, entityKey: string, baseRevisionId: string | null): string {
  return `ads-draft:${projectId}:${entityKey}:${baseRevisionId ?? "new"}`;
}

export function fingerprintOf(payload: unknown, ifMatch: number | null): string {
  return `${stableJson(payload)}|${ifMatch ?? ""}`;
}

export function nextDraft(
  existing: DraftRecord | null,
  payload: unknown,
  ifMatch: number | null,
  createKey: () => string,
): DraftRecord {
  const fingerprint = fingerprintOf(payload, ifMatch);
  if (existing && existing.fingerprint === fingerprint) {
    return { ...existing, payload };
  }
  return { fingerprint, idempotencyKey: createKey(), ifMatch, payload };
}

export function confirmConflictDraft(
  draft: DraftRecord,
  nextIfMatch: number | null,
  createKey: () => string,
): DraftRecord {
  return nextDraft(draft, draft.payload, nextIfMatch, createKey);
}

export interface PageState<T> {
  scope: string;
  items: T[];
  nextCursor: string | null;
}

export function applyPage<T>(
  current: PageState<T> | null,
  incoming: { scope: string; items: T[]; nextCursor: string | null; append: boolean },
): PageState<T> {
  const sameScope = current?.scope === incoming.scope;
  if (incoming.append && sameScope && current) {
    return { scope: incoming.scope, items: [...current.items, ...incoming.items], nextCursor: incoming.nextCursor };
  }
  return { scope: incoming.scope, items: incoming.items, nextCursor: incoming.nextCursor };
}

export function shouldApplyLoad(requestToken: number, currentToken: number): boolean {
  return requestToken === currentToken;
}

export function describeRevision(currentRevision: { id: string } | null): "empty" | "present" {
  return currentRevision === null ? "empty" : "present";
}

export function shouldPoll(workflowStatus: string, pageHidden: boolean): boolean {
  if (pageHidden) return false;
  return !TERMINAL_WORKFLOW_STATES.has(workflowStatus);
}

export function currentStoryRevision<T extends { revisionNo: number }>(items: readonly T[]): T | null {
  return items.reduce<T | null>((best, item) => (best === null || item.revisionNo > best.revisionNo ? item : best), null);
}

export function sourceUsable(input: {
  reviewStatus: string | null;
  freshnessStatus: string | null;
  currentId: string | null;
  approvedId: string | null;
  revisionId: string;
}): { usable: boolean; reason: string } {
  if (input.currentId === null || input.revisionId !== input.currentId) {
    return { usable: false, reason: "不是当前版本" };
  }
  if (input.approvedId === null || input.revisionId !== input.approvedId) {
    return { usable: false, reason: "尚未批准，不能当作可用来源" };
  }
  if (input.reviewStatus !== "APPROVED") {
    return { usable: false, reason: "审核状态不是 APPROVED" };
  }
  if (input.freshnessStatus !== "CURRENT") {
    return { usable: false, reason: "新鲜度不是 CURRENT" };
  }
  return { usable: true, reason: "" };
}

export interface JsonStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export function readDraft(storage: JsonStorage, key: string): DraftRecord | null {
  const raw = storage.getItem(key);
  if (!raw) return null;
  const parsed = JSON.parse(raw) as DraftRecord;
  if (typeof parsed.fingerprint !== "string" || typeof parsed.idempotencyKey !== "string") return null;
  return parsed;
}

export function writeDraft(storage: JsonStorage, key: string, draft: DraftRecord): void {
  storage.setItem(key, JSON.stringify(draft));
}

export function clearDraft(storage: JsonStorage, key: string): void {
  storage.removeItem(key);
}

export function releaseSubmittedDraft(storage: JsonStorage, key: string, submitted: DraftRecord): boolean {
  const latest = readDraft(storage, key);
  if (latest && latest.fingerprint !== submitted.fingerprint) return false;
  clearDraft(storage, key);
  return true;
}

export function activeDraftPointer(projectId: string, entityKey: string): string {
  return `ads-active:${projectId}:${entityKey}`;
}

export function readActiveDraftKey(storage: JsonStorage, projectId: string, entityKey: string): string | null {
  return storage.getItem(activeDraftPointer(projectId, entityKey));
}

export function rememberActiveDraft(storage: JsonStorage, projectId: string, entityKey: string, draftKey: string): void {
  storage.setItem(activeDraftPointer(projectId, entityKey), draftKey);
}

export function clearActiveDraft(storage: JsonStorage, projectId: string, entityKey: string): void {
  storage.removeItem(activeDraftPointer(projectId, entityKey));
}
