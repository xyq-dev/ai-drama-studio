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
  basis: string;
  unitType?: string;
  unitQuantity?: string;
  unitPriceSnapshot?: string;
  component?: string;
}

export interface MediaAccountingEnvelope {
  provider: string;
  model: string;
  usage?: Record<string, number>;
  costs: MediaCostLine[];
}

export interface MediaProviderObservation {
  state: MediaProviderState;
  normalizedEventKey: string;
  responseHash: string;
  observedAt: string;
  outputs?: MediaProviderOutput[];
  accounting?: MediaAccountingEnvelope;
  metadata?: Record<string, unknown>;
}

type MediaSubmitBase = {
  providerRequestId: string;
  accounting?: MediaAccountingEnvelope;
};

export type MediaSubmitResult =
  | (MediaSubmitBase & { kind: "succeeded"; outputs: MediaProviderOutput[] })
  | (MediaSubmitBase & { kind: "waiting"; nextPollAt: string })
  | (MediaSubmitBase & {
      kind: "failed";
      retryable: boolean;
      errorCode: string;
      errorMessage: string;
    })
  | (MediaSubmitBase & { kind: "canceled" });

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
