// Synthetic fixture only; never imported by application code.
import { VIMAX_PLANNING_BUDGET, vimaxPlanningStartSchema, vimaxPlanningViewSchema } from "@ai-drama/contracts";
import { vimaxCandidateFixture } from "./vimax-candidate-test-fixtures";
export function vimaxPlanningFixture() {
  const f = vimaxCandidateFixture();
  const r = f.request;
  const body = vimaxPlanningStartSchema.parse({ schema: "ads.vimax-planning.start.v1", target: f.create.target,
    source: r.source, sceneSpans: r.sceneSpans, selectedSceneKeys: r.selectedSceneKeys,
    sourceDialogue: r.sourceDialogue, requirements: r.requirements, confirmedTextSend: true });
  const view = vimaxPlanningViewSchema.parse({ schema: "ads.vimax-planning.view.v1", requestId: "d0000000-0000-4000-8000-000000000001",
    requestKey: "planning-key-1", requestHash: "a".repeat(64), projectId: f.source.projectId, episodeId: f.source.episodeId,
    state: "reserved", input: { schema: "ads.vimax-planning.frozen.v1", promptVersion: "ads.vimax-planning.prompt.v1",
      source: f.source, target: f.target, request: body, providerKey: "openai", model: "o-1", budget: { ...VIMAX_PLANNING_BUDGET } },
    errorCode: null, providerRequestId: null, responseModel: null,
    usage: { status: "unknown", inputTokens: null, outputTokens: null, totalTokens: null }, billing: "unknown", output: null,
    submittedAt: null, createdAt: "2026-11-01T00:00:00.000Z", finishedAt: null, quotaAccounting: "reservation" });
  const completed = vimaxPlanningViewSchema.parse({ ...view, state: "completed", output: f.create,
    submittedAt: "2026-11-01T00:00:01.000Z", finishedAt: "2026-11-01T00:00:02.000Z" });
  const unknown = vimaxPlanningViewSchema.parse({ ...view, state: "unknown", errorCode: "executor_lost",
    submittedAt: "2026-11-01T00:00:01.000Z", finishedAt: "2026-11-01T00:04:02.000Z" });
  const options = { schema: "ads.vimax-planning.options.v1" as const, enabled: true, code: "VIMAX_PLANNING_READY", storageReady: true,
    providerKey: "openai" as const, model: "o-1", budget: { ...VIMAX_PLANNING_BUDGET }, maxCallsPerDay: 10,
    quotaAccounting: "reservation" as const, billing: "unknown" as const };
  return { ...f, body, view, completed, unknown, options };
}
