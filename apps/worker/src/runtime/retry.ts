import { createHash } from "node:crypto";

export function retryAt(jobId: string, attemptNo: number): Date {
  const baseMs = Math.min(15 * 60_000, 30_000 * 2 ** Math.max(0, attemptNo - 1));
  const digest = createHash("sha256").update(`${jobId}:${attemptNo}`).digest();
  const jitterRatio = digest.readUInt32BE(0) / 0xffffffff;
  return new Date(Date.now() + baseMs + Math.floor(baseMs * 0.2 * jitterRatio));
}
