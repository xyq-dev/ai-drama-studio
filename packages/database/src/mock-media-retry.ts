import { createHash } from "node:crypto";
import type { PoolClient, QueryResultRow } from "pg";
import { SAMPLE_VIDEO_SCHEMA, frozenSampleFields } from "@ai-drama/contracts";
import { MAX_MANUAL_MEDIA_RETRIES, mediaRetryDecision, type MediaRetryRejection } from "@ai-drama/domain";
import { PersistenceError, type ManualRetryLineage, type ManualRetrySource } from "./job-service";
import type { MediaAssetStore } from "./media-assets";
import { assertFixedMockImageSnapshot } from "./mock-media-cost";
import { assertFrozenReferencesUsable, frozenCharacterReferences } from "./character-reference-store";
import { mockMediaRoute } from "./mock-media-kinds";

/** The same server switches that gate the original generate endpoints. */
export interface MockMediaRetryFlags {
  mockImageEnabled: boolean;
  mockAvEnabled: boolean;
  mockSmEnabled: boolean;
  mockSampleVideoEnabled: boolean;
}

const REJECTION_MESSAGES: Record<MediaRetryRejection, string> = {
  NOT_MEDIA: "Only Mock media jobs use the media retry rule",
  COMPOSE: "Compose must be submitted again after a new preflight",
  NOT_TERMINAL: "Manual retry requires FAILED or CANCELED job",
  SUCCEEDED: "A succeeded media job is regenerated from the shot page, not retried",
  UNKNOWN_OUTCOME: "The provider outcome is unknown; generate again explicitly instead of retrying",
  ERROR_NOT_RETRYABLE: "This media failure is not retryable",
};

function notRetryable(message: string, details?: Record<string, unknown>): PersistenceError {
  return new PersistenceError("JOB_NOT_RETRYABLE", message, details);
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/**
 * Builds the media retry lineage: the job must still be a Mock media job on its fixed route, its frozen snapshot
 * must match its own shot, the feature switch must be on, and the original generate gate must still pass.
 */
export function mockMediaRetryLineage(input: {
  workspaceId: string;
  mediaAssets: MediaAssetStore;
  flags: MockMediaRetryFlags;
}): ManualRetryLineage {
  return {
    maxManualRetries: MAX_MANUAL_MEDIA_RETRIES,
    authorize: async (client, source) => {
      const decision = mediaRetryDecision(source);
      if (!decision.allowed) {
        throw notRetryable(REJECTION_MESSAGES[decision.reason], { reason: decision.reason });
      }
      const snapshot = assertMockRoute(source);
      assertSwitchOn(source.kind, snapshot, input.flags);
      await assertMockAttempts(client, source);
      const shotRevisionId = source.sourceShotRevisionId!;
      const route = mockMediaRoute(source.kind)!;
      const prepared = await input.mediaAssets.prepareShotGenerationInTransaction(
        client, input.workspaceId, shotRevisionId, route.capability,
      );
      if (prepared.projectId !== source.projectId) {
        throw notRetryable("The source shot no longer belongs to this job's project");
      }
      // A strict video snapshot froze its selected character references; a retry copies them, so they must hold.
      const frozen = source.kind === "MEDIA_VIDEO" ? frozenCharacterReferences(snapshot) : null;
      if (frozen) await assertFrozenReferencesUsable(client, input.workspaceId, frozen);
      if (source.kind !== "MEDIA_IMAGE") {
        const current = (source.kind === "MEDIA_VIDEO" || source.kind === "MEDIA_MUSIC"
          ? prepared.promptText
          : prepared.dialogue ?? "").trim();
        const sourceHash = createHash("sha256").update(current).digest("hex");
        if (current.length === 0 || snapshot.sourceText !== current || snapshot.sourceHash !== sourceHash) {
          throw notRetryable("The saved shot source no longer matches the job input");
        }
      }
    },
  };
}

function assertMockRoute(source: ManualRetrySource): Record<string, unknown> {
  const route = mockMediaRoute(source.kind);
  const snapshot = record(source.inputSnapshot);
  if (!route || !snapshot || !source.sourceShotRevisionId) {
    throw notRetryable("The job is not on a Mock media route");
  }
  if (snapshot.shotRevisionId !== source.sourceShotRevisionId) {
    throw notRetryable("The job input does not match its source shot");
  }
  if (source.kind === "MEDIA_IMAGE") {
    try {
      assertFixedMockImageSnapshot(snapshot, source.sourceShotRevisionId);
    } catch {
      throw notRetryable("The job is not on a Mock media route");
    }
    return snapshot;
  }
  const sample = source.kind === "MEDIA_VIDEO" && snapshot.schema === SAMPLE_VIDEO_SCHEMA;
  if (sample ? frozenSampleFields(snapshot) === null : snapshot.schema !== route.schema) {
    throw notRetryable("The job is not on a Mock media route");
  }
  if (snapshot.capability !== route.capability || snapshot.outcome !== "success" || snapshot.executionMode !== "sync"
    || typeof snapshot.sourceText !== "string" || typeof snapshot.sourceHash !== "string") {
    throw notRetryable("The job is not on a Mock media route");
  }
  return snapshot;
}

function assertSwitchOn(kind: string, snapshot: Record<string, unknown>, flags: MockMediaRetryFlags): void {
  const enabled = kind === "MEDIA_IMAGE"
    ? flags.mockImageEnabled
    : kind === "MEDIA_VIDEO" || kind === "MEDIA_TTS"
      ? flags.mockAvEnabled && (snapshot.schema !== SAMPLE_VIDEO_SCHEMA || flags.mockSampleVideoEnabled)
      : flags.mockSmEnabled;
  if (!enabled) {
    throw new PersistenceError("CONFIGURATION_ERROR", "The Mock media switch for this job is not enabled");
  }
}

/** Every attempt the job already made must have run on the Mock media provider for the same capability. */
async function assertMockAttempts(client: PoolClient, source: ManualRetrySource): Promise<void> {
  const route = mockMediaRoute(source.kind)!;
  const attempts = await client.query<{ provider_key: string | null; capability: string | null } & QueryResultRow>(
    `SELECT pc.provider_key, pc.capability
       FROM job_attempt attempt
       LEFT JOIN provider_configuration pc
         ON pc.id = attempt.provider_configuration_id
        AND pc.workspace_id = attempt.workspace_id
      WHERE attempt.generation_job_id = $1 AND attempt.workspace_id = $2`,
    [source.jobId, source.workspaceId],
  );
  for (const attempt of attempts.rows) {
    if (attempt.provider_key !== "mock-media" || attempt.capability !== route.capability) {
      throw notRetryable("The job did not run on the Mock media provider");
    }
  }
}
