import { createHash } from "node:crypto";
import type {
  MediaAccountingEnvelope,
  MediaCapability,
  MediaGenerationRequest,
  MediaProviderAdapter,
  MediaProviderObservation,
  MediaProviderOutput,
  MediaResolvedOutput,
  MediaSubmitResult,
} from "./media-adapter";

export class MockMediaAdapter implements MediaProviderAdapter {
  readonly providerKey = "mock-media";
  private readonly pending = new Set<string>();
  private readonly pollCounts = new Map<string, number>();

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
      return { kind: "canceled", providerRequestId, accounting: actualAccounting(providerRequestId) };
    }
    if (outcome === "retryable_failure") {
      return {
        kind: "failed",
        providerRequestId,
        retryable: true,
        errorCode: "MOCK_MEDIA_RETRYABLE",
        errorMessage: "Mock media adapter requested a retry",
        accounting: actualAccounting(providerRequestId),
      };
    }
    if (outcome === "terminal_failure") {
      return {
        kind: "failed",
        providerRequestId,
        retryable: false,
        errorCode: "MOCK_MEDIA_TERMINAL",
        errorMessage: "Mock media adapter failed terminally",
        accounting: actualAccounting(providerRequestId),
      };
    }
    if (outcome === "delayed") {
      this.pending.add(providerRequestId);
      this.pollCounts.set(providerRequestId, 0);
      return {
        kind: "waiting",
        providerRequestId,
        nextPollAt: new Date().toISOString(),
        accounting: estimatedAccounting(providerRequestId),
      };
    }

    return {
      kind: "succeeded",
      providerRequestId,
      outputs: [mockOutput(input, providerRequestId)],
      accounting: actualAccounting(providerRequestId),
    };
  }

  async inspect(providerRequestId: string): Promise<MediaProviderObservation> {
    const pollNo = (this.pollCounts.get(providerRequestId) ?? 0) + 1;
    this.pollCounts.set(providerRequestId, pollNo);

    let state: MediaProviderObservation["state"] = "UNKNOWN";
    let outputs: MediaProviderOutput[] | undefined;
    if (this.pending.delete(providerRequestId)) {
      state = "ACTIVE";
    } else if (providerRequestId.startsWith("mock-media|")) {
      state = "SUCCEEDED";
      outputs = [mockOutputFromRequestId(providerRequestId)];
    }

    const normalizedEventKey = `poll:${providerRequestId}:${pollNo}`;
    const responseHash = createHash("sha256")
      .update(JSON.stringify({ providerRequestId, pollNo, state }))
      .digest("hex");

    return {
      state,
      normalizedEventKey,
      responseHash,
      observedAt: new Date().toISOString(),
      outputs,
      accounting:
        state === "ACTIVE"
          ? estimatedAccounting(providerRequestId)
          : state === "UNKNOWN"
            ? undefined
            : actualAccounting(providerRequestId),
      metadata: { pollNo },
    };
  }

  async resolveOutput(output: MediaProviderOutput): Promise<MediaResolvedOutput> {
    if (output.retrieval.kind === "URI") {
      return { uri: output.retrieval.uri, expiresAt: output.retrieval.expiresAt };
    }
    const mimeType = output.mimeTypeHint ?? "application/octet-stream";
    return { uri: `data:${mimeType};base64,AA==` };
  }
}

function mockOutput(input: MediaGenerationRequest, providerRequestId: string): MediaProviderOutput {
  return outputFor(input.capability, providerRequestId);
}

function mockOutputFromRequestId(providerRequestId: string): MediaProviderOutput {
  const capability = providerRequestId.split("|")[1] as MediaCapability | undefined;
  return outputFor(capability ?? "image.generate", providerRequestId);
}

function outputFor(capability: MediaCapability, providerRequestId: string): MediaProviderOutput {
  const digest = createHash("sha256").update(providerRequestId).digest("hex");
  const kind =
    capability === "image.generate"
      ? "IMAGE"
      : capability === "video.generate"
        ? "VIDEO"
        : capability === "subtitle.generate"
          ? "SUBTITLE"
          : capability === "audio.music"
            ? "MUSIC"
            : capability === "media.compose_input_validate"
              ? "COMPOSITE"
              : "AUDIO";
  return {
    kind,
    retrieval: { kind: "HANDLE", handle: `mock-output:${digest}` },
    mimeTypeHint:
      kind === "IMAGE"
        ? "image/png"
        : kind === "VIDEO"
          ? "video/mp4"
          : kind === "SUBTITLE"
            ? "text/vtt"
            : kind === "COMPOSITE"
              ? "application/json"
              : "audio/wav",
    metadata: { providerRequestId },
  };
}

function estimatedAccounting(providerRequestId: string): MediaAccountingEnvelope {
  return accounting(providerRequestId, "ESTIMATED");
}

function actualAccounting(providerRequestId: string): MediaAccountingEnvelope {
  return accounting(providerRequestId, "ACTUAL");
}

function accounting(
  providerRequestId: string,
  kind: "ESTIMATED" | "ACTUAL",
): MediaAccountingEnvelope {
  return {
    provider: "mock-media",
    model: "mock-v1",
    usage: { requests: 1 },
    costs: [
      {
        idempotencyKey: `${providerRequestId}:request:${kind.toLowerCase()}`,
        kind,
        currency: "USD",
        amountDecimal: "0.00000000",
        basis: "REQUEST",
        unitType: "request",
        unitQuantity: "1.00000000",
        unitPriceSnapshot: "0.00000000",
        component: "request",
      },
    ],
  };
}
