import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  SAMPLE_VIDEO_DESCRIPTIONS,
  SAMPLE_VIDEO_FIXTURE_IDS,
  type SampleVideoFixtureId,
} from "@ai-drama/contracts";

const cache = new Map<SampleVideoFixtureId, Buffer>();

function load(fixtureId: SampleVideoFixtureId): Buffer {
  const cached = cache.get(fixtureId);
  if (cached) return cached;
  const description = SAMPLE_VIDEO_DESCRIPTIONS[fixtureId];
  const bytes = readFileSync(join(__dirname, "..", "fixtures", `${fixtureId}.mp4`));
  const checksumSha256 = createHash("sha256").update(bytes).digest("hex");
  if (checksumSha256 !== description.checksumSha256 || bytes.length !== description.byteSize) {
    throw new Error(`Committed sample fixture ${fixtureId} does not match its contract`);
  }
  cache.set(fixtureId, bytes);
  return bytes;
}

for (const fixtureId of SAMPLE_VIDEO_FIXTURE_IDS) load(fixtureId);

export function sampleVideoBytes(fixtureId: SampleVideoFixtureId): Buffer {
  return Buffer.from(load(fixtureId));
}
