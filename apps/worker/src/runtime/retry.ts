import { createHash } from "node:crypto";

export function retryAt(jobId: string, attemptNo: number, retryAfterMs = 0): Date {
  const baseMs = Math.min(15 * 60_000, 30_000 * 2 ** Math.max(0, attemptNo - 1));
  const digest = createHash("sha256").update(`${jobId}:${attemptNo}`).digest();
  const jitterRatio = digest.readUInt32BE(0) / 0xffffffff;
  const backoffMs = baseMs + Math.floor(baseMs * 0.2 * jitterRatio);
  return new Date(Date.now() + Math.max(backoffMs, retryAfterMs));
}
