export const MEDIA_CAPABILITIES = [
  "image.generate",
  "video.generate",
  "audio.tts",
  "audio.music",
  "subtitle.generate",
  "media.compose_input_validate",
] as const;

export type MediaCapability = (typeof MEDIA_CAPABILITIES)[number];
export type MediaAssetKind = "IMAGE" | "VIDEO" | "AUDIO" | "SUBTITLE" | "MUSIC" | "COMPOSITE";
export type MediaProviderState = "ACTIVE" | "SUCCEEDED" | "FAILED" | "CANCELED" | "UNKNOWN";
export type MediaCostKind = "ESTIMATED" | "ACTUAL";

export interface MediaGenerationRequest {
  workspaceId: string;
  projectId: string;
  shotRevisionId?: string;
  generationJobId: string;
  jobAttemptId: string;
  providerConfigurationId: string;
  clientRequestKey: string;
  inputHash: string;
  inputSnapshot: unknown;
  traceId: string;
  capability: MediaCapability;
  /** Verified bytes loaded by the worker; never part of the frozen snapshot or public DTO. */
  resolvedSourceImage?: { bytes: Uint8Array; mimeType: "image/png" | "image/jpeg"; checksumSha256: string };
}

/** The request may have reached a paid service. A caller must persist UNKNOWN, never retry submit. */
export class MediaSubmissionUnknownError extends Error {
  readonly code = "MEDIA_SUBMISSION_UNKNOWN";
  constructor(readonly providerRequestId?: string) {
    super("媒体服务可能已经受理，请核实原请求；不要自动重新生成。");
    this.name = "MediaSubmissionUnknownError";
  }
}

export type MediaOutputReference =
  | { kind: "URI"; uri: string; expiresAt?: string }
  | { kind: "HANDLE"; handle: string };

export interface MediaProviderOutput {
  kind: MediaAssetKind;
  retrieval: MediaOutputReference;
  mimeTypeHint?: string;
  metadata?: Record<string, unknown>;
}

export interface MediaResolvedOutput {
  uri: string;
  expiresAt?: string;
  headers?: Record<string, string>;
}

export interface MediaCostLine {
  idempotencyKey: string;
  kind: MediaCostKind;
  currency: string;
  amountDecimal: string;
  basis: "PROVIDER_REPORTED" | "LOCALLY_CALCULATED";
  unitType?: string;
  unitQuantity?: string;
  unitPriceSnapshot?: string;
  component: string;
  supersedesEstimateKey?: string;
}

export interface MediaAccountingEnvelope {
  provider: string;
  model: string;
  usage?: Record<string, number>;
  costs: MediaCostLine[];
}

interface MediaProviderObservationBase {
  normalizedEventKey: string;
  responseHash: string;
  observedAt: string;
  accounting?: MediaAccountingEnvelope;
  metadata?: Record<string, unknown>;
}

export type MediaProviderObservation =
  | (MediaProviderObservationBase & {
      state: "SUCCEEDED";
      outputs: [MediaProviderOutput, ...MediaProviderOutput[]];
    })
  | (MediaProviderObservationBase & {
      state: "FAILED";
      outputs?: never;
      retryable: boolean;
      errorCode: string;
      errorMessage: string;
    })
  | (MediaProviderObservationBase & {
      state: Exclude<MediaProviderState, "SUCCEEDED" | "FAILED">;
      outputs?: never;
    });

type MediaSubmitWithRequest = {
  providerRequestId: string;
  accounting?: MediaAccountingEnvelope;
};

type MediaSubmitWithoutRequiredRequest = {
  providerRequestId?: string;
  accounting?: MediaAccountingEnvelope;
};

export type MediaSubmitResult =
  | (MediaSubmitWithRequest & { kind: "succeeded"; outputs: [MediaProviderOutput, ...MediaProviderOutput[]] })
  | (MediaSubmitWithRequest & { kind: "waiting"; nextPollAt: string })
  | (MediaSubmitWithoutRequiredRequest & {
      kind: "failed";
      retryable: boolean;
      errorCode: string;
      errorMessage: string;
    })
  | (MediaSubmitWithoutRequiredRequest & { kind: "canceled" });

/** @deprecated Provider outputs are not durable Assets until Core validates and stores them. */
export type MediaAssetDescriptor = MediaProviderOutput;

export interface MediaProviderAdapter {
  readonly providerKey: string;
  capabilities(): readonly MediaCapability[];
  submit(input: MediaGenerationRequest): Promise<MediaSubmitResult>;
  inspect(providerRequestId: string): Promise<MediaProviderObservation>;
  resolveOutput(output: MediaProviderOutput): Promise<MediaResolvedOutput>;
  cancel?(providerRequestId: string): Promise<void>;
}
