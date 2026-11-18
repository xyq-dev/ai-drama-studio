/**
 * Creator account isolation + configurable usage-plan / ledger skeleton (phase 4).
 * Browser-safe: no node:fs. Import via `@ai-drama/domain/creator-account-plan`.
 *
 * Unit prices stay configurable and may be empty. Empty / unknown amounts display as 「尚未计价」.
 * No locked RMB prices, membership tiers, payment channels, or card storage.
 */

/** Well-known legacy owner seeded by 20261118000100_creator_account_plan on the earliest workspace. */
export const LEGACY_OWNER_ACCOUNT_ID = "a0000000-0000-4000-8000-000000000001";
export const LEGACY_OWNER_USERNAME = "legacy-owner";

export type CreatorAccountRole = "operator" | "creator";
export type CreatorLedgerStatus = "pending_price" | "posted";
export type CreatorLedgerEntryKind = "debit" | "credit" | "adjustment";
export type CreatorPlanEntitlementStatus = "active" | "exhausted" | "unpriced";

/** Honest amount label when a unit price is missing or billing is still unknown. */
export function formatCreatorPlanUnpricedAmount(): string {
  return "尚未计价";
}

export function formatCreatorPlanUnitPrice(input: {
  unitPriceAmount: string | number | null | undefined;
  unitPriceCurrency?: string | null;
}): string {
  if (input.unitPriceAmount === null || input.unitPriceAmount === undefined || input.unitPriceAmount === "") {
    return formatCreatorPlanUnpricedAmount();
  }
  const amount = typeof input.unitPriceAmount === "number"
    ? input.unitPriceAmount
    : Number(input.unitPriceAmount);
  if (!Number.isFinite(amount)) return formatCreatorPlanUnpricedAmount();
  const currency = input.unitPriceCurrency?.trim();
  return currency ? `${String(amount)} ${currency}` : String(amount);
}

export function formatCreatorPlanRemaining(input: {
  remainingUnits: string | number | null | undefined;
  unitLabel?: string | null;
  entitlementStatus?: CreatorPlanEntitlementStatus | string | null;
  unitPriceAmount?: string | number | null;
}): string {
  if (input.entitlementStatus === "unpriced"
    || input.remainingUnits === null
    || input.remainingUnits === undefined
    || input.unitPriceAmount === null
    || input.unitPriceAmount === undefined
    || input.unitPriceAmount === "") {
    return `余量 ${formatCreatorPlanUnpricedAmount()}`;
  }
  const units = typeof input.remainingUnits === "number"
    ? input.remainingUnits
    : Number(input.remainingUnits);
  if (!Number.isFinite(units)) return `余量 ${formatCreatorPlanUnpricedAmount()}`;
  const label = input.unitLabel?.trim() || "unit";
  return `余量 ${String(units)} ${label}`;
}

export function formatCreatorLedgerStatus(status: CreatorLedgerStatus | string): string {
  if (status === "posted") return "已入账";
  if (status === "pending_price") return "待计价";
  return formatCreatorPlanUnpricedAmount();
}

export function formatCreatorLedgerAmount(input: {
  status: CreatorLedgerStatus | string;
  amountDecimal?: string | number | null;
  currency?: string | null;
}): string {
  if (input.status !== "posted"
    || input.amountDecimal === null
    || input.amountDecimal === undefined
    || input.amountDecimal === "") {
    return formatCreatorPlanUnpricedAmount();
  }
  const amount = typeof input.amountDecimal === "number"
    ? input.amountDecimal
    : Number(input.amountDecimal);
  if (!Number.isFinite(amount)) return formatCreatorPlanUnpricedAmount();
  const currency = input.currency?.trim();
  return currency ? `${String(amount)} ${currency}` : String(amount);
}

/**
 * Traceable ledger row summary for creator-visible history.
 * Always names account, work/task, time, usage, and status — never invents an amount.
 */
export function formatCreatorLedgerRecord(input: {
  accountId: string;
  projectId?: string | null;
  taskKey?: string | null;
  occurredAt: string;
  usageSummary: string;
  status: CreatorLedgerStatus | string;
  amountDecimal?: string | number | null;
  currency?: string | null;
  entryKind: CreatorLedgerEntryKind | string;
}): string {
  const work = input.projectId?.trim() || input.taskKey?.trim() || "无关联作品";
  const task = input.taskKey?.trim() ? `任务 ${input.taskKey.trim()}` : "任务 无";
  return [
    `账户 ${input.accountId}`,
    `作品 ${work}`,
    task,
    `时间 ${input.occurredAt}`,
    `用量 ${input.usageSummary}`,
    `状态 ${formatCreatorLedgerStatus(input.status)}`,
    `金额 ${formatCreatorLedgerAmount(input)}`,
    `类型 ${input.entryKind}`,
  ].join("；");
}

/**
 * A billing action may write the ledger only after explicit confirmation.
 * Unconfirmed clicks must not post; unknown fees must not auto-resend.
 */
export function mayPostCreatorLedgerEntry(input: {
  confirmed: boolean;
  feeKnown?: boolean;
}): boolean {
  return input.confirmed === true;
}

/** Unconfirmed or fee-unknown requests are not billed failures to retry. */
export function unconfirmedCreatorBillingIsBilledFailure(): boolean {
  return false;
}

export function mayAutoResendCreatorBillingWhenUnconfirmedOrUnpriced(): boolean {
  return false;
}

/** Cross-account project access: prefer opaque 404 over a revealing 403. */
export function creatorCrossAccountAccessStatus(): 404 {
  return 404;
}

export function creatorCrossAccountNotFoundMessage(): string {
  return "Project not found";
}
