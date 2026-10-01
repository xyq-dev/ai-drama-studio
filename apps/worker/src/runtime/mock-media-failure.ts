const PERMANENT_CODES = new Set(["REVIEW_REQUIRED", "NOT_FOUND", "COST_CONFLICT"]);
const TERMINAL_RACE_CODES = new Set(["JOB_TERMINAL", "ATTEMPT_SUPERSEDED"]);

/** Thrown by this worker before any database write. Database failures are classified by code, not by this text. */
const DETERMINISTIC_OUTPUT = /canonical fixture|request identity changed|expected success|only supports success|not a synchronous|accounting|requires exactly one|must be inline PNG|not a PNG|dimensions are invalid/;

export type MediaFailureDisposition = "permanent" | "retryable" | "terminal-race";

export function mediaErrorCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error && typeof (error as { code: unknown }).code === "string") {
    return (error as { code: string }).code;
  }
  return "";
}

export function mediaErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Shared by synchronous AV execution and media recovery. Persistence codes decide database failures. */
export function classifyMediaFailure(error: unknown): MediaFailureDisposition {
  const code = mediaErrorCode(error);
  if (TERMINAL_RACE_CODES.has(code)) return "terminal-race";
  if (code === "STALE_RECALCULATION_PENDING") return "retryable";
  if (PERMANENT_CODES.has(code)) return "permanent";
  if (DETERMINISTIC_OUTPUT.test(mediaErrorMessage(error))) return "permanent";
  return "retryable";
}
