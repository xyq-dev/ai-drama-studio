export interface StoredAttemptView {
  attemptNo: number;
  providerKey: string | null;
  model: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  errorCode: string | null;
  inputHash: string | null;
  requestBytes: number;
  costAmount: string | null;
  costCurrency: string | null;
  costKind: string | null;
}

export interface PresentedAttempt {
  attemptNo: number;
  providerKey: string | null;
  model: string | null;
  status: "running" | "finished";
  errorCode: string | null;
  durationMs: number | null;
  inputHash: string | null;
  requestBytes: number;
  cost: { status: "recorded"; amount: string; currency: string; kind: string }
    | { status: "unknown"; amount: null; currency: null; kind: null };
}

export function presentStoredAttempt(input: StoredAttemptView): PresentedAttempt {
  const started = input.startedAt ? Date.parse(input.startedAt) : Number.NaN;
  const finished = input.finishedAt ? Date.parse(input.finishedAt) : Number.NaN;
  const durationMs = Number.isFinite(started) && Number.isFinite(finished) && finished >= started
    ? finished - started
    : null;
  const recorded = input.costAmount !== null && input.costCurrency !== null && input.costKind !== null;
  return {
    attemptNo: input.attemptNo,
    providerKey: input.providerKey,
    model: input.model,
    status: input.finishedAt ? "finished" : "running",
    errorCode: input.errorCode,
    durationMs,
    inputHash: input.inputHash,
    requestBytes: input.requestBytes,
    cost: recorded
      ? { status: "recorded", amount: input.costAmount as string, currency: input.costCurrency as string, kind: input.costKind as string }
      : { status: "unknown", amount: null, currency: null, kind: null },
  };
}
