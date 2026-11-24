import { z } from "zod";

const timeMs = z.number().int().nonnegative().safe();
const finding = z.object({
  code: z.enum(["BLACK", "SILENCE", "NO_AUDIO", "NO_VIDEO"]),
  startMs: timeMs.optional(),
  endMs: timeMs.optional(),
}).strict().refine(
  (value) => value.endMs === undefined || (value.startMs !== undefined && value.endMs >= value.startMs),
  "Invalid quality finding interval",
);

export const episodeQualityReportSchema = z.object({
  skill: z.literal("qc-skill"),
  version: z.string().min(1).max(64),
  status: z.enum(["PASS", "FAIL", "UNKNOWN"]),
  findings: z.array(finding).max(64),
  reason: z.enum(["CHECK_UNAVAILABLE", "INCOMPLETE"]).optional(),
}).strict().refine((value) => {
  if (value.status === "UNKNOWN") return value.reason !== undefined;
  if (value.reason !== undefined) return false;
  return value.status === "PASS" ? value.findings.length === 0 : value.findings.length > 0;
}, "Quality report has inconsistent findings or status");

export type EpisodeQualityReport = z.infer<typeof episodeQualityReportSchema>;
