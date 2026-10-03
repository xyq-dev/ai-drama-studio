export const SAMPLE_VIDEO_SCHEMA = "m4.mock.sample-video.v1";
export const SAMPLE_VIDEO_FIXTURE_IDS = ["sample-15s-a-v1", "sample-15s-b-v1"] as const;
export type SampleVideoFixtureId = (typeof SAMPLE_VIDEO_FIXTURE_IDS)[number];

export interface SampleVideoDescription {
  fixtureId: SampleVideoFixtureId;
  checksumSha256: string;
  byteSize: number;
  width: 180;
  height: 320;
  frameRate: 5;
  frameCount: 75;
  durationMs: 15000;
  hasAudio: false;
  mimeType: "video/mp4";
  codec: "h264";
  pixFmt: "yuv420p";
}

/** Offline lavfi fixtures. Hashes belong to the committed provider files, not a runtime render. */
export const SAMPLE_VIDEO_DESCRIPTIONS: { readonly [K in SampleVideoFixtureId]: SampleVideoDescription } = {
  "sample-15s-a-v1": {
    fixtureId: "sample-15s-a-v1",
    checksumSha256: "4f46bf904a42c7d3acd0cda9d37ccaa2de71dda095a6f91a83c211d5d48f04e7",
    byteSize: 28643,
    width: 180,
    height: 320,
    frameRate: 5,
    frameCount: 75,
    durationMs: 15000,
    hasAudio: false,
    mimeType: "video/mp4",
    codec: "h264",
    pixFmt: "yuv420p",
  },
  "sample-15s-b-v1": {
    fixtureId: "sample-15s-b-v1",
    checksumSha256: "21f1c5ac372b71337e2a615e3994fdbf812aa79b7a7dc0a88c6de13401e8e60f",
    byteSize: 28392,
    width: 180,
    height: 320,
    frameRate: 5,
    frameCount: 75,
    durationMs: 15000,
    hasAudio: false,
    mimeType: "video/mp4",
    codec: "h264",
    pixFmt: "yuv420p",
  },
};

const JOB_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isSampleVideoFixtureId(value: unknown): value is SampleVideoFixtureId {
  return typeof value === "string" && (SAMPLE_VIDEO_FIXTURE_IDS as readonly string[]).includes(value);
}

export function sampleVideoDescription(fixtureId: SampleVideoFixtureId): SampleVideoDescription {
  return SAMPLE_VIDEO_DESCRIPTIONS[fixtureId];
}

export function looksLikeSampleVideoRequestId(value: string): boolean {
  return value.startsWith("mock-media|sample-sync-v1|");
}

export function isSampleVideoSnapshot(value: unknown): boolean {
  return Boolean(value) && typeof value === "object" && (value as { schema?: unknown }).schema === SAMPLE_VIDEO_SCHEMA;
}

export interface ParsedSampleVideoRequest {
  fixtureId: SampleVideoFixtureId;
  jobId: string;
  attemptNo: number;
}

/** Five fields. A malformed sample id is null and must not be treated as the one-second mock. */
export function parseSampleVideoRequestId(value: string): ParsedSampleVideoRequest | null {
  const parts = value.split("|");
  if (parts.length !== 5) return null;
  if (parts[0] !== "mock-media" || parts[1] !== "sample-sync-v1" || parts[2] !== "video.generate") return null;
  const fixtureId = parts[3];
  const tail = parts[4];
  if (!isSampleVideoFixtureId(fixtureId) || !tail) return null;
  const colon = tail.lastIndexOf(":");
  if (colon <= 0) return null;
  const jobId = tail.slice(0, colon);
  const attemptText = tail.slice(colon + 1);
  if (!JOB_ID.test(jobId) || !/^[1-9][0-9]*$/.test(attemptText)) return null;
  const attemptNo = Number(attemptText);
  if (!Number.isSafeInteger(attemptNo) || attemptNo > 2_147_483_647) return null;
  return { fixtureId, jobId, attemptNo };
}

export function formatSampleVideoRequestId(input: ParsedSampleVideoRequest): string {
  const requestId = `mock-media|sample-sync-v1|video.generate|${input.fixtureId}|${input.jobId}:${input.attemptNo}`;
  const parsed = parseSampleVideoRequestId(requestId);
  if (!parsed || parsed.fixtureId !== input.fixtureId || parsed.jobId !== input.jobId || parsed.attemptNo !== input.attemptNo) {
    throw new Error("Sample video request identity is not the canonical fixture");
  }
  return requestId;
}

export interface FrozenSampleVideoFields {
  fixtureId: SampleVideoFixtureId;
  checksumSha256: string;
  byteSize: number;
  width: number;
  height: number;
  frameRate: number;
  frameCount: number;
  durationMs: number;
}

/** Returns the catalog entry only when every frozen field matches it. */
export function frozenSampleFields(value: unknown): FrozenSampleVideoFields | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (record.schema !== SAMPLE_VIDEO_SCHEMA || record.hasAudio !== false || !isSampleVideoFixtureId(record.fixtureId)) return null;
  const description = SAMPLE_VIDEO_DESCRIPTIONS[record.fixtureId];
  if (
    record.checksumSha256 !== description.checksumSha256 ||
    record.byteSize !== description.byteSize ||
    record.width !== description.width ||
    record.height !== description.height ||
    record.frameRate !== description.frameRate ||
    record.frameCount !== description.frameCount ||
    record.durationMs !== description.durationMs
  ) {
    return null;
  }
  return {
    fixtureId: description.fixtureId,
    checksumSha256: description.checksumSha256,
    byteSize: description.byteSize,
    width: description.width,
    height: description.height,
    frameRate: description.frameRate,
    frameCount: description.frameCount,
    durationMs: description.durationMs,
  };
}

export function sampleVideoRequestIdFromSnapshot(snapshot: unknown, clientRequestKey: string): string | null {
  if (!isSampleVideoSnapshot(snapshot)) return null;
  const frozen = frozenSampleFields(snapshot);
  if (!frozen) throw new Error("Sample video snapshot is not the canonical fixture");
  const colon = clientRequestKey.lastIndexOf(":");
  if (colon <= 0) throw new Error("Sample video request identity is not the canonical fixture");
  const attemptNo = Number(clientRequestKey.slice(colon + 1));
  return formatSampleVideoRequestId({
    fixtureId: frozen.fixtureId,
    jobId: clientRequestKey.slice(0, colon),
    attemptNo,
  });
}

export function sampleVideoGenerationEnabled(input: {
  nodeEnv: string;
  sampleFlag: boolean;
  avFlag: boolean;
  directoryReady: boolean;
}): boolean {
  return input.nodeEnv !== "production" && input.sampleFlag && input.avFlag && input.directoryReady;
}
