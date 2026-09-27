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

export interface MediaAssetDescriptor {
  kind: MediaAssetKind;
  objectKey: string;
  mimeType: string;
  checksumSha256: string;
  byteSize: number;
  width?: number;
  height?: number;
  durationMs?: number;
  metadata?: Record<string, unknown>;
}

export type MediaSubmitResult =
  | { kind: "succeeded"; providerRequestId: string; assets: MediaAssetDescriptor[] }
  | { kind: "waiting"; providerRequestId: string; nextPollAt: string }
  | { kind: "failed"; providerRequestId: string; retryable: boolean; errorCode: string; errorMessage: string }
  | { kind: "canceled"; providerRequestId: string };

export interface MediaProviderAdapter {
  readonly providerKey: string;
  capabilities(): readonly MediaCapability[];
  submit(input: MediaGenerationRequest): Promise<MediaSubmitResult>;
  inspect(providerRequestId: string): Promise<MediaProviderState>;
  cancel?(providerRequestId: string): Promise<void>;
}
