import { createHash } from "node:crypto";
import { DomainError } from "./errors";

export const REVIEW_STATUSES = ["DRAFT", "IN_REVIEW", "APPROVED", "REJECTED"] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

export const FRESHNESS_STATUSES = ["CURRENT", "STALE"] as const;
export type FreshnessStatus = (typeof FRESHNESS_STATUSES)[number];

export const PRODUCTION_EPISODE_NUMBERS = [1, 2, 3] as const;

const reviewTransitions: Readonly<Record<ReviewStatus, readonly ReviewStatus[]>> = {
  DRAFT: ["IN_REVIEW"],
  IN_REVIEW: ["APPROVED", "REJECTED"],
  APPROVED: [],
  REJECTED: [],
};

const forbiddenCanonicalKeys = new Set([
  "created_at",
  "updated_at",
  "reviewed_at",
  "row_version",
  "review_version",
  "createdAt",
  "updatedAt",
  "reviewedAt",
  "rowVersion",
  "reviewVersion",
]);

export function assertReviewTransition(from: ReviewStatus, to: ReviewStatus): void {
  if (!reviewTransitions[from].includes(to)) {
    throw new DomainError("REVIEW_INVALID_TRANSITION", `Review cannot transition from ${from} to ${to}`);
  }
}

export function assertProductionEpisodeSet(episodeNumbers: readonly number[]): void {
  const present = new Set(episodeNumbers);
  const matches =
    present.size === PRODUCTION_EPISODE_NUMBERS.length &&
    PRODUCTION_EPISODE_NUMBERS.every((episodeNo) => present.has(episodeNo));
  if (!matches) {
    throw new DomainError("EPISODE_SET_INVALID", "Production requires exactly episodes 1, 2, and 3");
  }
}

export function canonicalJson(value: unknown): string {
  assertCanonicalValue(value);
  return serializeCanonical(value);
}

export function canonicalInputHash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function assertCanonicalValue(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) assertCanonicalValue(item);
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (forbiddenCanonicalKeys.has(key)) {
        throw new DomainError("CANONICAL_INPUT_FORBIDDEN", `Canonical input cannot include ${key}`);
      }
      assertCanonicalValue(item);
    }
  }
}

function serializeCanonical(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => serializeCanonical(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
      left.localeCompare(right),
    );
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${serializeCanonical(item)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
