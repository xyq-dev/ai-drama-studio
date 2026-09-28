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

function assertCanonicalValue(value: unknown, ancestors = new Set<object>()): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (typeof value !== "object" || value === null) {
    throw new DomainError("CANONICAL_INPUT_INVALID", "Canonical input must contain only JSON values");
  }
  const array = Array.isArray(value);
  if (!array && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    throw new DomainError("CANONICAL_INPUT_INVALID", "Canonical input objects must be plain JSON objects");
  }
  if (ancestors.has(value)) {
    throw new DomainError("CANONICAL_INPUT_INVALID", "Canonical input cannot contain cycles");
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new DomainError("CANONICAL_INPUT_INVALID", "Canonical input cannot contain symbol keys");
  }
  ancestors.add(value);
  try {
    if (array) {
      for (const item of value) assertCanonicalValue(item, ancestors);
      return;
    }
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
      if (!descriptor.enumerable) continue;
      if (descriptor.get || descriptor.set) {
        throw new DomainError("CANONICAL_INPUT_INVALID", "Canonical input cannot contain accessors");
      }
      if (forbiddenCanonicalKeys.has(key)) {
        throw new DomainError("CANONICAL_INPUT_FORBIDDEN", `Canonical input cannot include ${key}`);
      }
      assertCanonicalValue(descriptor.value, ancestors);
    }
  } finally {
    ancestors.delete(value);
  }
}

function normalizeCanonicalString(value: string): string {
  return value.replace(/\r\n?/g, "\n").normalize("NFC");
}

function serializeCanonical(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => serializeCanonical(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const normalizedEntries = Object.entries(value as Record<string, unknown>).map(([key, item]) => [
      normalizeCanonicalString(key),
      item,
    ] as const);
    const seen = new Set<string>();
    for (const [key] of normalizedEntries) {
      if (seen.has(key)) {
        throw new DomainError("CANONICAL_INPUT_DUPLICATE_KEY", "Canonical input contains equivalent normalized keys");
      }
      seen.add(key);
    }
    normalizedEntries.sort(([left], [right]) =>
      Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8")) || (left < right ? -1 : left > right ? 1 : 0),
    );
    return `{${normalizedEntries
      .map(([key, item]) => `${JSON.stringify(key)}:${serializeCanonical(item)}`)
      .join(",")}}`;
  }
  if (typeof value === "string") {
    return JSON.stringify(normalizeCanonicalString(value));
  }
  return JSON.stringify(value) ?? "null";
}
