import { DomainError } from "./errors";

export const PROJECT_COST_SUMMARY_SCHEMA = "m4.project.cost-summary.v1";
export const LOCAL_COMPOSE_JOB_SCHEMAS = ["m4.shot.compose.v1", "m4.episode.compose.v1"] as const;

const AMOUNT_TEXT = /^(0|[1-9]\d*)\.\d{8}$/;
const CURRENCY_TEXT = /^[A-Z]{3}$/;

export interface ProjectCostCurrency {
  currency: string;
  actualAmount: string;
  outstandingEstimatedAmount: string;
  actualEntryCount: number;
  outstandingEstimatedEntryCount: number;
  supersededEstimatedEntryCount: number;
}

export interface ProjectCostCoverage {
  jobCount: number;
  attemptCount: number;
  jobsWithoutLedgerCount: number;
  providerBoundAttemptsWithoutLedgerCount: number;
  localComposeAttemptCount: number;
  ledgerRowsWithoutAttemptCount: number;
}

export interface ProjectCostSummary {
  schema: typeof PROJECT_COST_SUMMARY_SCHEMA;
  projectId: string;
  snapshotAt: string;
  ledgerRowCount: number;
  currencies: ProjectCostCurrency[];
  coverage: ProjectCostCoverage;
  boundary: {
    localEncodeCostMetered: false;
    totalProductionCostKnown: false;
  };
}

export interface RecordedLedgerFact {
  id: string;
  currency: string;
  amount: string;
  kind: "ACTUAL" | "ESTIMATED";
  supersedesCostId: string | null;
  jobAttemptId: string | null;
}

export function assertLedgerAmount(value: string): string {
  if (!AMOUNT_TEXT.test(value)) {
    throw new DomainError("VALIDATION_ERROR", "Ledger amount is not a fixed 8-decimal string");
  }
  return value;
}

export function addLedgerAmounts(left: string, right: string): string {
  const sum = BigInt(assertLedgerAmount(left).replace(".", "")) + BigInt(assertLedgerAmount(right).replace(".", ""));
  const digits = sum.toString().padStart(9, "0");
  return `${digits.slice(0, -8).replace(/^0+(?=\d)/, "")}.${digits.slice(-8)}`;
}

export function summarizeRecordedLedger(rows: readonly RecordedLedgerFact[]): ProjectCostCurrency[] {
  const superseded = new Set(rows.filter((row) => row.kind === "ACTUAL" && row.supersedesCostId).map((row) => row.supersedesCostId));
  const currencies = new Map<string, ProjectCostCurrency>();
  for (const row of rows) {
    const current = currencies.get(row.currency) ?? {
      currency: row.currency,
      actualAmount: "0.00000000",
      outstandingEstimatedAmount: "0.00000000",
      actualEntryCount: 0,
      outstandingEstimatedEntryCount: 0,
      supersededEstimatedEntryCount: 0,
    };
    if (row.kind === "ACTUAL") {
      current.actualAmount = addLedgerAmounts(current.actualAmount, row.amount);
      current.actualEntryCount += 1;
    } else if (superseded.has(row.id)) {
      current.supersededEstimatedEntryCount += 1;
    } else {
      current.outstandingEstimatedAmount = addLedgerAmounts(current.outstandingEstimatedAmount, row.amount);
      current.outstandingEstimatedEntryCount += 1;
    }
    currencies.set(row.currency, current);
  }
  return [...currencies.values()].sort((left, right) => left.currency.localeCompare(right.currency));
}

export function buildProjectCostSummary(input: {
  projectId: string;
  snapshotAt: string;
  ledgerRowCount: number;
  currencies: ProjectCostCurrency[];
  coverage: ProjectCostCoverage;
}): ProjectCostSummary {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.projectId)) {
    throw new DomainError("VALIDATION_ERROR", "Project id is invalid");
  }
  if (Number.isNaN(Date.parse(input.snapshotAt))) {
    throw new DomainError("VALIDATION_ERROR", "Cost snapshot time is invalid");
  }
  const currencies = [...input.currencies]
    .map((row) => ({
      currency: row.currency,
      actualAmount: assertLedgerAmount(row.actualAmount),
      outstandingEstimatedAmount: assertLedgerAmount(row.outstandingEstimatedAmount),
      actualEntryCount: count(row.actualEntryCount),
      outstandingEstimatedEntryCount: count(row.outstandingEstimatedEntryCount),
      supersededEstimatedEntryCount: count(row.supersededEstimatedEntryCount),
    }))
    .sort((left, right) => left.currency.localeCompare(right.currency));
  const seen = new Set<string>();
  for (const row of currencies) {
    if (!CURRENCY_TEXT.test(row.currency) || seen.has(row.currency)) {
      throw new DomainError("VALIDATION_ERROR", "Cost currency is invalid");
    }
    seen.add(row.currency);
  }
  return {
    schema: PROJECT_COST_SUMMARY_SCHEMA,
    projectId: input.projectId,
    snapshotAt: new Date(input.snapshotAt).toISOString(),
    ledgerRowCount: count(input.ledgerRowCount),
    currencies,
    coverage: {
      jobCount: count(input.coverage.jobCount),
      attemptCount: count(input.coverage.attemptCount),
      jobsWithoutLedgerCount: count(input.coverage.jobsWithoutLedgerCount),
      providerBoundAttemptsWithoutLedgerCount: count(input.coverage.providerBoundAttemptsWithoutLedgerCount),
      localComposeAttemptCount: count(input.coverage.localComposeAttemptCount),
      ledgerRowsWithoutAttemptCount: count(input.coverage.ledgerRowsWithoutAttemptCount),
    },
    boundary: {
      localEncodeCostMetered: false,
      totalProductionCostKnown: false,
    },
  };
}

function count(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new DomainError("VALIDATION_ERROR", "Cost count is invalid");
  }
  return value;
}
