import { randomUUID } from "node:crypto";
import {
  SCRIPT_BREAKDOWN_CALL_CAP,
  SCRIPT_BREAKDOWN_INPUT_SCHEMA,
  SCRIPT_BREAKDOWN_PROMPT_VERSION,
  SCRIPT_BREAKDOWN_STEP_KEY,
  isScriptBreakdownInput,
  type ScriptBreakdownDetails,
  type ScriptBreakdownFrozenInput,
  type ScriptBreakdownOutput,
  type ScriptBreakdownRunView,
  type TitleRunBundle,
  type TitleRunRecord,
  type TitleWritingCallView,
  type TitleWritingStoredProviderKey,
} from "@ai-drama/contracts";
import { canonicalInputHash, plannedTotalSeconds } from "@ai-drama/domain";

/**
 * Identity of a breakdown start request as the caller sent it: the work, the episode, the provider and model when given
 * (null when omitted) and whether existing scenes may be replaced. Neither the frozen script and scenes nor the server's
 * current defaults are part of it, so the same request replayed after the script or the provider settings changed still
 * finds its original run instead of conflicting or creating a second one.
 */
export function hashScriptBreakdownRequest(projectId: string, request: {
  episodeId: string; providerKey: TitleWritingStoredProviderKey | null; model: string | null; replaceExisting: boolean;
}): string {
  return canonicalInputHash({ kind: "script_breakdown", projectId, request });
}

export function newScriptBreakdownRun(options: {
  workspaceId: string;
  projectId: string;
  actorId: string;
  idempotencyKey: string;
  requestHash: string;
  input: Omit<ScriptBreakdownFrozenInput, "schema" | "promptVersion">;
  now: Date;
}): TitleRunRecord {
  const input: ScriptBreakdownFrozenInput = {
    schema: SCRIPT_BREAKDOWN_INPUT_SCHEMA,
    promptVersion: SCRIPT_BREAKDOWN_PROMPT_VERSION,
    ...options.input,
  };
  const createdAt = options.now.toISOString();
  return {
    id: randomUUID(),
    workspaceId: options.workspaceId,
    projectId: options.projectId,
    actorId: options.actorId,
    idempotencyKey: options.idempotencyKey,
    inputHash: options.requestHash,
    input,
    state: "running",
    errorCode: null,
    cancelRequestedAt: null,
    executorId: null,
    leaseUntil: null,
    callCap: SCRIPT_BREAKDOWN_CALL_CAP,
    callsUsed: 0,
    storySave: "pending",
    storyRevisionId: null,
    breakdownSave: "pending",
    createdAt,
    updatedAt: createdAt,
  };
}

export function isScriptBreakdownRun(run: TitleRunRecord): run is TitleRunRecord & { input: ScriptBreakdownFrozenInput } {
  return isScriptBreakdownInput(run.input);
}

/** Public view: no executor, idempotency key, request hash, script copy, raw response or credential. */
export function scriptBreakdownRunView(bundle: TitleRunBundle, details: ScriptBreakdownDetails): ScriptBreakdownRunView {
  const { run } = bundle;
  if (!isScriptBreakdownRun(run)) throw new Error("not a script breakdown run");
  const input = run.input;
  const step = bundle.steps.find((item) => item.stepKey === SCRIPT_BREAKDOWN_STEP_KEY);
  const output = step?.state === "completed" && step.output ? step.output as ScriptBreakdownOutput : null;
  return {
    runId: run.id,
    projectId: run.projectId,
    episodeId: input.episodeId,
    episodeNo: input.episodeNo,
    scriptRevisionId: input.scriptRevisionId,
    scriptRevisionNo: input.scriptRevisionNo,
    targetEpisodeSeconds: input.targetEpisodeSeconds,
    characters: input.characters.map((item) => ({ ...item })),
    replacedScenes: input.replace.scenes.length,
    providerKey: input.providerKey,
    model: input.model,
    state: run.state,
    errorCode: run.errorCode,
    cancelRequested: run.cancelRequestedAt !== null,
    callCap: run.callCap,
    callsUsed: run.callsUsed,
    step: { state: step?.state ?? "pending", attemptNo: step?.attemptNo ?? 0, errorCode: step?.errorCode ?? null },
    output,
    plannedTotalSeconds: output ? plannedTotalSeconds(output) : null,
    save: run.breakdownSave ?? "pending",
    scenes: details.scenes,
    episodeScript: details.episodeScript,
    calls: [...bundle.calls].sort((left, right) => left.createdAt.localeCompare(right.createdAt)).map((call): TitleWritingCallView => ({
      callId: call.id,
      stepKey: call.stepKey,
      attemptNo: call.attemptNo,
      providerKey: call.providerKey,
      model: call.model,
      responseModel: call.responseModel,
      providerRequestId: call.providerRequestId,
      state: call.state,
      errorCode: call.errorCode,
      usage: call.usage,
      billingStatus: "unknown",
      createdAt: call.createdAt,
      finishedAt: call.finishedAt,
    })),
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
  };
}
