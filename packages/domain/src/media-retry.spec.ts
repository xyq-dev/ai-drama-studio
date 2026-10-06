import { describe, expect, it } from "vitest";
import {
  MAX_MANUAL_MEDIA_RETRIES,
  MEDIA_RETRY_JOB_KINDS,
  RETRYABLE_MEDIA_ERROR_CODES,
  isMediaRetryJobKind,
  mediaRetryDecision,
} from "./media-retry";

const PERMANENT_CODES = [
  "MOCK_IMAGE_OUTPUT_INVALID",
  "MOCK_AV_OUTPUT_INVALID",
  "MOCK_SM_OUTPUT_INVALID",
  "MOCK_MEDIA_NOT_CONFIGURED",
  "MOCK_MEDIA_ROUTE_INVALID",
  "MOCK_PROVIDER_FAILED",
];

describe("media manual retry decision", () => {
  it("covers exactly the five Mock media kinds with a two-retry chain", () => {
    expect(MEDIA_RETRY_JOB_KINDS).toEqual(["MEDIA_IMAGE", "MEDIA_VIDEO", "MEDIA_TTS", "MEDIA_SUBTITLE", "MEDIA_MUSIC"]);
    expect(MAX_MANUAL_MEDIA_RETRIES).toBe(2);
    expect(isMediaRetryJobKind("MEDIA_COMPOSE")).toBe(false);
    expect(isMediaRetryJobKind("MOCK_TEXT_SHOTS")).toBe(false);
  });

  it.each(MEDIA_RETRY_JOB_KINDS)("allows %s only from CANCELED or a whitelisted FAILED code", (kind) => {
    expect(mediaRetryDecision({ kind, state: "CANCELED", errorCode: null })).toEqual({ allowed: true });
    for (const code of RETRYABLE_MEDIA_ERROR_CODES) {
      expect(mediaRetryDecision({ kind, state: "FAILED", errorCode: code })).toEqual({ allowed: true });
    }
    for (const code of PERMANENT_CODES) {
      expect(mediaRetryDecision({ kind, state: "FAILED", errorCode: code }))
        .toEqual({ allowed: false, reason: "ERROR_NOT_RETRYABLE" });
    }
    expect(mediaRetryDecision({ kind, state: "FAILED", errorCode: null }))
      .toEqual({ allowed: false, reason: "ERROR_NOT_RETRYABLE" });
    expect(mediaRetryDecision({ kind, state: "FAILED", errorCode: "MOCK_REQUEST_UNKNOWN" }))
      .toEqual({ allowed: false, reason: "UNKNOWN_OUTCOME" });
    expect(mediaRetryDecision({ kind, state: "SUCCEEDED", errorCode: null }))
      .toEqual({ allowed: false, reason: "SUCCEEDED" });
    for (const state of ["PENDING", "QUEUED", "RUNNING", "WAITING_EXTERNAL"]) {
      expect(mediaRetryDecision({ kind, state, errorCode: null })).toEqual({ allowed: false, reason: "NOT_TERMINAL" });
    }
  });

  it("keeps compose and non-media jobs out of the media rule", () => {
    expect(mediaRetryDecision({ kind: "MEDIA_COMPOSE", state: "FAILED", errorCode: "LEASE_EXPIRED" }))
      .toEqual({ allowed: false, reason: "COMPOSE" });
    expect(mediaRetryDecision({ kind: "MOCK", state: "FAILED", errorCode: "MOCK_RETRYABLE" }))
      .toEqual({ allowed: false, reason: "NOT_MEDIA" });
  });
});
