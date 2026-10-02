import { lstat, mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { PersistenceError } from "@ai-drama/database";
import { buildEpisodeExportManifest, episodeExportFilenameStem, type EpisodeExportFacts } from "@ai-drama/domain";

export function parseExpectedContentHash(query: Record<string, unknown>): string {
  const keys = Object.keys(query).filter((key) => query[key] !== undefined);
  if (keys.length !== 1 || keys[0] !== "expectedContentHash") {
    throw new PersistenceError("VALIDATION_ERROR", "Request query is invalid");
  }
  const value = query.expectedContentHash;
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    throw new PersistenceError("VALIDATION_ERROR", "Request query is invalid");
  }
  return value;
}

export function exportIdentity(facts: EpisodeExportFacts): string {
  return JSON.stringify({
    assetId: facts.assetId,
    checksumSha256: facts.checksumSha256,
    byteSize: facts.byteSize,
    objectKey: facts.objectKey,
    inputHash: facts.inputHash,
    preflightInputHash: facts.preflightInputHash,
    rowVersion: facts.rowVersion,
    segments: facts.segments,
  });
}

export function attachmentDisposition(filename: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(filename)) {
    throw new PersistenceError("COMPOSE_INPUT_INVALID", "Episode export name is not usable");
  }
  return `attachment; filename="${filename}"`;
}

export function episodeExportBody(facts: EpisodeExportFacts, verifiedAt: string) {
  return {
    filenameStem: episodeExportFilenameStem(facts.episodeNo, facts.assetId),
    manifest: buildEpisodeExportManifest(facts, verifiedAt),
  };
}

export async function holdEpisodeExportLatch(): Promise<void> {
  const dir = process.env.M4_EPISODE_EXPORT_LATCH_DIR;
  if (dir == null || dir === "") return;
  if (!isAbsolute(dir)) throw new PersistenceError("CONFIGURATION_ERROR", "Episode export latch is not configured");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "ready"), "");
  const release = join(dir, "release");
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const info = await lstat(release);
      if (info.isFile() && !info.isSymbolicLink()) return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new PersistenceError("COMPOSE_INPUT_INVALID", "Episode export was not released");
}
