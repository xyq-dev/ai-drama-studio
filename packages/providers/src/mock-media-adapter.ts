import { createHash } from "node:crypto";
import { mockMediaFixture } from "./mock-media-fixtures";
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
    if (this.pending.delete(providerRequestId)) {
      const accounting = estimatedAccounting(providerRequestId);
      const responseHash = observationHash(providerRequestId, "ACTIVE", undefined, accounting);
      return {
        state: "ACTIVE",
        normalizedEventKey: `poll:${responseHash}`,
        responseHash,
        observedAt: new Date().toISOString(),
        accounting,
        metadata: { source: "mock" },
      };
    }

    if (providerRequestId.startsWith("mock-media|")) {
      const outputs: [MediaProviderOutput, ...MediaProviderOutput[]] = [
        mockOutputFromRequestId(providerRequestId),
      ];
      const accounting = actualAccounting(providerRequestId, true);
      const responseHash = observationHash(providerRequestId, "SUCCEEDED", outputs, accounting);
      return {
        state: "SUCCEEDED",
        normalizedEventKey: `poll:${responseHash}`,
        responseHash,
        observedAt: new Date().toISOString(),
        outputs,
        accounting,
        metadata: { source: "mock" },
      };
    }

    const responseHash = observationHash(providerRequestId, "UNKNOWN");
    return {
      state: "UNKNOWN",
      normalizedEventKey: `poll:${responseHash}`,
      responseHash,
      observedAt: new Date().toISOString(),
      metadata: { source: "mock" },
    };
  }

  async resolveOutput(output: MediaProviderOutput): Promise<MediaResolvedOutput> {
    if (output.retrieval.kind === "URI") {
      return { uri: output.retrieval.uri, expiresAt: output.retrieval.expiresAt };
    }
    const mimeType = output.mimeTypeHint ?? "application/octet-stream";
    const bytes = mockMediaFixture(mimeType);
    return { uri: `data:${mimeType};base64,${bytes.toString("base64")}` };
  }
}

function observationHash(
  providerRequestId: string,
  state: MediaProviderObservation["state"],
  outputs?: MediaProviderOutput[],
  accounting?: MediaAccountingEnvelope,
): string {
  return createHash("sha256")
    .update(JSON.stringify({ providerRequestId, state, outputs, accounting }))
    .digest("hex");
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

function actualAccounting(
  providerRequestId: string,
  supersedeEstimate = false,
): MediaAccountingEnvelope {
  return accounting(providerRequestId, "ACTUAL", supersedeEstimate);
}

function accounting(
  providerRequestId: string,
  kind: "ESTIMATED" | "ACTUAL",
  supersedeEstimate = false,
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
        basis: "PROVIDER_REPORTED",
        unitType: "request",
        unitQuantity: "1.00000000",
        unitPriceSnapshot: "0.00000000",
        component: "request",
        supersedesEstimateKey:
          kind === "ACTUAL" && supersedeEstimate
            ? `${providerRequestId}:request:estimated`
            : undefined,
      },
    ],
  };
}
