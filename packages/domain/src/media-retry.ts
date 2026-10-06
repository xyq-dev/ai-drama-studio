/** Manual retry rules for the five Mock media job kinds. The server re-checks these inside the retry transaction. */
export const MEDIA_RETRY_JOB_KINDS = ["MEDIA_IMAGE", "MEDIA_VIDEO", "MEDIA_TTS", "MEDIA_SUBTITLE", "MEDIA_MUSIC"] as const;

export type MediaRetryJobKind = (typeof MEDIA_RETRY_JOB_KINDS)[number];

/** Each initial media job may produce at most this many manual retry successors along one chain. */
export const MAX_MANUAL_MEDIA_RETRIES = 2;

/**
 * FAILED codes whose cause can clear on a fresh job: the worker classified them as retryable and the
 * automatic attempts ran out, or the worker lease expired. Output, configuration and route failures are
 * deterministic and stay rejected. MOCK_REQUEST_UNKNOWN is rejected because the request may already have run.
 */
export const RETRYABLE_MEDIA_ERROR_CODES = [
  "MOCK_IMAGE_RUNTIME_FAILED",
  "MOCK_AV_RUNTIME_FAILED",
  "MOCK_SM_RUNTIME_FAILED",
  "LEASE_EXPIRED",
] as const;

export type MediaRetryRejection =
  | "NOT_MEDIA"
  | "COMPOSE"
  | "NOT_TERMINAL"
  | "SUCCEEDED"
  | "UNKNOWN_OUTCOME"
  | "ERROR_NOT_RETRYABLE";

export type MediaRetryDecision = { allowed: true } | { allowed: false; reason: MediaRetryRejection };

export function isMediaRetryJobKind(kind: string): kind is MediaRetryJobKind {
  return (MEDIA_RETRY_JOB_KINDS as readonly string[]).includes(kind);
}

export function mediaRetryDecision(input: {
  kind: string;
  state: string;
  errorCode: string | null;
}): MediaRetryDecision {
  if (input.kind === "MEDIA_COMPOSE") return { allowed: false, reason: "COMPOSE" };
  if (!isMediaRetryJobKind(input.kind)) return { allowed: false, reason: "NOT_MEDIA" };
  if (input.state === "CANCELED") return { allowed: true };
  if (input.state === "SUCCEEDED") return { allowed: false, reason: "SUCCEEDED" };
  if (input.state !== "FAILED") return { allowed: false, reason: "NOT_TERMINAL" };
  if (input.errorCode === "MOCK_REQUEST_UNKNOWN") return { allowed: false, reason: "UNKNOWN_OUTCOME" };
  if (input.errorCode !== null && (RETRYABLE_MEDIA_ERROR_CODES as readonly string[]).includes(input.errorCode)) {
    return { allowed: true };
  }
  return { allowed: false, reason: "ERROR_NOT_RETRYABLE" };
}
