import { describe, expect, it } from "vitest";
import {
  SAMPLE_VIDEO_DESCRIPTIONS,
  SAMPLE_VIDEO_SCHEMA,
  formatSampleVideoRequestId,
  frozenSampleFields,
  looksLikeSampleVideoRequestId,
  parseSampleVideoRequestId,
  sampleVideoGenerationEnabled,
  sampleVideoRequestIdFromSnapshot,
} from "./sample-video";

const jobId = "44444444-4444-4444-8444-444444444444";

describe("sample video identity", () => {
  it("parses only the two fixed fixtures and five identity fields", () => {
    const requestId = formatSampleVideoRequestId({ fixtureId: "sample-15s-a-v1", jobId, attemptNo: 1 });
    expect(requestId).toBe(`mock-media|sample-sync-v1|video.generate|sample-15s-a-v1|${jobId}:1`);
    expect(parseSampleVideoRequestId(requestId)?.fixtureId).toBe("sample-15s-a-v1");
    expect(parseSampleVideoRequestId(`mock-media|sync|video.generate|${jobId}:1`)).toBeNull();
    expect(parseSampleVideoRequestId("mock-media|sample-sync-v1|video.generate|sample-15s-c-v1|" + jobId + ":1")).toBeNull();
    expect(parseSampleVideoRequestId(`mock-media|sample-sync-v1|video.generate|sample-15s-a-v1|${jobId}`)).toBeNull();
    expect(parseSampleVideoRequestId(`mock-media|sample-sync-v1|audio.tts|sample-15s-a-v1|${jobId}:1`)).toBeNull();
    expect(looksLikeSampleVideoRequestId("mock-media|sample-sync-v1|nope")).toBe(true);
  });

  it("requires every frozen field to match the catalog", () => {
    const description = SAMPLE_VIDEO_DESCRIPTIONS["sample-15s-b-v1"];
    const snapshot = { schema: SAMPLE_VIDEO_SCHEMA, ...description, shotRevisionId: jobId, sourceText: "技术验收样片" };
    expect(frozenSampleFields(snapshot)?.fixtureId).toBe("sample-15s-b-v1");
    expect(frozenSampleFields({ ...snapshot, byteSize: description.byteSize - 1 })).toBeNull();
    expect(frozenSampleFields({ ...snapshot, fixtureId: "sample-15s-a-v1" })).toBeNull();
    expect(sampleVideoRequestIdFromSnapshot(snapshot, `${jobId}:2`)).toContain("sample-15s-b-v1");
    expect(() => sampleVideoRequestIdFromSnapshot({ schema: SAMPLE_VIDEO_SCHEMA }, `${jobId}:1`)).toThrow(/canonical fixture/);
  });

  it("stays off unless the sample flag, AV flag, directory, and non-production mode all agree", () => {
    const open = { nodeEnv: "development", sampleFlag: true, avFlag: true, directoryReady: true };
    expect(sampleVideoGenerationEnabled(open)).toBe(true);
    expect(sampleVideoGenerationEnabled({ ...open, sampleFlag: false })).toBe(false);
    expect(sampleVideoGenerationEnabled({ ...open, avFlag: false })).toBe(false);
    expect(sampleVideoGenerationEnabled({ ...open, directoryReady: false })).toBe(false);
    expect(sampleVideoGenerationEnabled({ ...open, nodeEnv: "production" })).toBe(false);
  });
});
