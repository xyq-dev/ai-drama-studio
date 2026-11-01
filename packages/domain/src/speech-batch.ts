import type { SpeechBatchBudget, SpeechBatchConfirmation, SpeechBatchFrozenOperation } from "@ai-drama/contracts";
import { SPEECH_BATCH_MAX_OPERATIONS } from "@ai-drama/contracts";
import { DomainError } from "./errors";
import { realMediaAmount, realMediaAmountUnits } from "./real-media";

function aggregateUnits(value: string): bigint {
  if (!/^(?:0|[1-9][0-9]{0,9})(?:\.[0-9]{1,8})?$/.test(value)) throw new DomainError("SPEECH_BATCH_BUDGET_CHANGED", "Invalid aggregate amount");
  const [integer, fraction = ""] = value.split(".");
  return BigInt(integer!) * 100000000n + BigInt(fraction.padEnd(8, "0"));
}

export function speechBatchBudgets(operations: SpeechBatchFrozenOperation[]): SpeechBatchBudget[] {
  if (!operations.length || operations.length > SPEECH_BATCH_MAX_OPERATIONS) throw new DomainError("SPEECH_BATCH_LIMIT", "Choose between 1 and 100 operations");
  const totals = new Map<"CNY" | "USD", { estimated: bigint | null; maximum: bigint }>();
  for (const { input, quote } of operations) {
    if (input.inputHash !== quote.inputHash) throw new DomainError("SPEECH_BATCH_INVALID", "Quote differs from the frozen line");
    const maximum = realMediaAmountUnits(quote.maximumAmount);
    const estimated = quote.estimatedAmount === null ? null : realMediaAmountUnits(quote.estimatedAmount);
    if (maximum <= 0n || estimated !== null && estimated > maximum) throw new DomainError("SPEECH_BATCH_INVALID", "Quote amount is invalid");
    const prior = totals.get(quote.currency) ?? { estimated: 0n, maximum: 0n };
    totals.set(quote.currency, { maximum: prior.maximum + maximum,
      estimated: prior.estimated === null || estimated === null ? null : prior.estimated + estimated });
  }
  return [...totals].sort(([a], [b]) => a.localeCompare(b)).map(([currency, value]) => ({ currency,
    estimatedAmount: value.estimated === null ? null : realMediaAmount(value.estimated), maximumAmount: realMediaAmount(value.maximum) }));
}
export function assertSpeechBatchConfirmation(operations: SpeechBatchFrozenOperation[], frozenHash: string, body: SpeechBatchConfirmation): void {
  if (body.frozenHash !== frozenHash || body.maximumJobs !== operations.length) throw new DomainError("SPEECH_BATCH_CONFIRMATION_CHANGED", "Confirm the frozen operation count");
  const expected = speechBatchBudgets(operations);
  if (new Set(body.budgets.map((b) => b.currency)).size !== body.budgets.length || body.budgets.length !== expected.length
    || expected.some((b) => !body.budgets.some((v) => v.currency === b.currency && aggregateUnits(v.maximumAmount) === aggregateUnits(b.maximumAmount)))) {
    throw new DomainError("SPEECH_BATCH_BUDGET_CHANGED", "Confirm each fixed currency total");
  }
  const unknown = [...new Set(operations.flatMap((o) => o.quote.uncertainJobIds ?? []))].sort();
  const confirmed = [...new Set(body.confirmedUncertainJobIds)].sort();
  if (unknown.length !== confirmed.length || unknown.some((v, i) => v !== confirmed[i])) throw new DomainError("REAL_MEDIA_UNCERTAIN_CHANGED", "Confirm all prior unknown jobs");
}
