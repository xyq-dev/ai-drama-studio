import { createHash } from "node:crypto";
import {
  looksLikeSampleVideoRequestId,
  parseSampleVideoRequestId,
  sampleVideoRequestIdFromSnapshot,
  type SampleVideoFixtureId,
} from "@ai-drama/contracts";
import { mockMediaFixture } from "./mock-media-fixtures";
import { sampleVideoBytes } from "./sample-video";
import {
  MEDIA_CAPABILITIES,
  type MediaAccountingEnvelope,
  type MediaCapability,
  type MediaGenerationRequest,
  type MediaProviderAdapter,
  type MediaProviderObservation,
  type MediaProviderOutput,
  type MediaResolvedOutput,
  type MediaSubmitResult,
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
    const snapshot = input.inputSnapshot as { outcome?: string; executionMode?: string } | null;
    const sampleRequestId = sampleVideoRequestIdFromSnapshot(input.inputSnapshot, input.clientRequestKey);
    if (sampleRequestId) {
      if (input.capability !== "video.generate") {
        throw new Error("Sample video request identity is not the canonical fixture");
      }
      const fixtureId = parseSampleVideoRequestId(sampleRequestId)?.fixtureId;
      if (!fixtureId) throw new Error("Sample video request identity is not the canonical fixture");
      return {
        kind: "succeeded",
        providerRequestId: sampleRequestId,
        outputs: [sampleOutput(sampleRequestId, fixtureId)],
        accounting: actualAccounting(sampleRequestId),
      };
    }
    const providerRequestId = snapshot?.executionMode === "sync"
      ? `mock-media|sync|${input.capability}|${input.clientRequestKey}`
      : `mock-media|${input.capability}|${input.clientRequestKey}`;
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

    if (looksLikeSampleVideoRequestId(providerRequestId)) {
      const sample = parseSampleVideoRequestId(providerRequestId);
      if (!sample) {
        const unknownHash = observationHash(providerRequestId, "UNKNOWN");
        return {
          state: "UNKNOWN",
          normalizedEventKey: `poll:${unknownHash}`,
          responseHash: unknownHash,
          observedAt: new Date().toISOString(),
          metadata: { source: "mock" },
        };
      }
      const outputs: [MediaProviderOutput, ...MediaProviderOutput[]] = [
        sampleOutput(providerRequestId, sample.fixtureId),
      ];
      const accounting = actualAccounting(providerRequestId);
      const responseHash = observationHash(providerRequestId, "SUCCEEDED", outputs, accounting);
      return {
        state: "SUCCEEDED",
        normalizedEventKey: `poll:${responseHash}`,
        responseHash,
        observedAt: new Date().toISOString(),
        outputs,
        accounting,
        metadata: { source: "mock", fixtureId: sample.fixtureId },
      };
    }

    const parsed = parseRequestId(providerRequestId);
    if (parsed) {
      const outputs: [MediaProviderOutput, ...MediaProviderOutput[]] = [
        outputFor(parsed.capability, providerRequestId),
      ];
      const accounting = actualAccounting(providerRequestId, !parsed.sync);
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
    if (output.retrieval.kind === "HANDLE" && output.retrieval.handle.startsWith("mock-sample:")) {
      const requestId = output.retrieval.handle.slice("mock-sample:".length);
      const sample = parseSampleVideoRequestId(requestId);
      const metadata = output.metadata as { providerRequestId?: unknown; fixtureId?: unknown } | undefined;
      if (!sample || metadata?.providerRequestId !== requestId || metadata.fixtureId !== sample.fixtureId) {
        throw new Error("Sample video request identity is not the canonical fixture");
      }
      const bytes = sampleVideoBytes(sample.fixtureId);
      return { uri: `data:video/mp4;base64,${bytes.toString("base64")}` };
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

function parseRequestId(providerRequestId: string): { capability: MediaCapability; sync: boolean } | null {
  const parts = providerRequestId.split("|");
  if (parts[0] !== "mock-media") return null;
  const sync = parts[1] === "sync";
  const capability = sync ? parts[2] : parts[1];
  if (!capability || !MEDIA_CAPABILITIES.includes(capability as MediaCapability)) return null;
  return { capability: capability as MediaCapability, sync };
}

function sampleOutput(providerRequestId: string, fixtureId: SampleVideoFixtureId): MediaProviderOutput {
  return {
    kind: "VIDEO",
    retrieval: { kind: "HANDLE", handle: `mock-sample:${providerRequestId}` },
    mimeTypeHint: "video/mp4",
    metadata: { providerRequestId, fixtureId },
  };
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
              : capability === "audio.tts"
                ? "AUDIO"
                : null;
  if (!kind) throw new Error(`Unsupported mock media capability: ${capability}`);
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
