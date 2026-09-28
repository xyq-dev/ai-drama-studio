import { createHash } from "node:crypto";
import type {
  MediaAssetDescriptor,
  MediaCapability,
  MediaGenerationRequest,
  MediaProviderAdapter,
  MediaProviderState,
  MediaSubmitResult,
} from "./media-adapter";

export class MockMediaAdapter implements MediaProviderAdapter {
  readonly providerKey = "mock-media";
  private readonly pending = new Set<string>();

  capabilities(): readonly MediaCapability[] {
    return [
      "image.generate",
      "video.generate",
      "audio.tts",
      "audio.music",
      "subtitle.generate",
      "media.compose_input_validate",
    ];
  }

  async submit(input: MediaGenerationRequest): Promise<MediaSubmitResult> {
    const providerRequestId = `mock-media|${input.capability}|${input.clientRequestKey}`;
    const snapshot = input.inputSnapshot as { outcome?: string } | null;
    const outcome = snapshot?.outcome ?? "success";

    if (outcome === "cancel") {
      return { kind: "canceled", providerRequestId };
    }
    if (outcome === "retryable_failure") {
      return {
        kind: "failed",
        providerRequestId,
        retryable: true,
        errorCode: "MOCK_MEDIA_RETRYABLE",
        errorMessage: "Mock media adapter requested a retry",
      };
    }
    if (outcome === "terminal_failure") {
      return {
        kind: "failed",
        providerRequestId,
        retryable: false,
        errorCode: "MOCK_MEDIA_TERMINAL",
        errorMessage: "Mock media adapter failed terminally",
      };
    }
    if (outcome === "delayed") {
      this.pending.add(providerRequestId);
      return { kind: "waiting", providerRequestId, nextPollAt: new Date().toISOString() };
    }

    return {
      kind: "succeeded",
      providerRequestId,
      assets: [mockAsset(input, providerRequestId)],
    };
  }

  async inspect(providerRequestId: string): Promise<MediaProviderState> {
    if (this.pending.delete(providerRequestId)) return "ACTIVE";
    if (providerRequestId.startsWith("mock-media|")) return "SUCCEEDED";
    return "UNKNOWN";
  }
}

function mockAsset(input: MediaGenerationRequest, providerRequestId: string): MediaAssetDescriptor {
  const digest = createHash("sha256").update(providerRequestId).digest("hex");
  const kind =
    input.capability === "image.generate"
      ? "IMAGE"
      : input.capability === "video.generate"
        ? "VIDEO"
        : input.capability === "subtitle.generate"
          ? "SUBTITLE"
          : input.capability === "audio.music"
            ? "MUSIC"
            : input.capability === "media.compose_input_validate"
              ? "COMPOSITE"
              : "AUDIO";
  return {
    kind,
    objectKey: `mock/${digest}`,
    mimeType:
      kind === "IMAGE"
        ? "image/png"
        : kind === "VIDEO"
          ? "video/mp4"
          : kind === "SUBTITLE"
            ? "text/vtt"
            : kind === "COMPOSITE"
              ? "application/json"
              : "audio/wav",
    checksumSha256: digest,
    byteSize: 1,
    metadata: { providerRequestId },
  };
}
