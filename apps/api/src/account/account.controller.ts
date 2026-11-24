import { Body, Controller, Get, Headers, Inject, Optional, Post, Query, Res } from "@nestjs/common";
import type { CreatorPlanLedgerStore } from "@ai-drama/database";
import {
  formatCreatorLedgerRecord,
  formatCreatorPlanRemaining,
  formatCreatorPlanUnitPrice,
  mayPostCreatorLedgerEntry,
  sessionAllowsStaffPermission,
} from "@ai-drama/domain";
import { CREATOR_PLAN_LEDGER_STORE, AUTH_WORKSPACE_ID } from "../auth/auth.tokens";
import { MEMBERSHIP_STORE, writingPreflight, type MembershipStore } from "../membership/membership-store";
import { MEMBERSHIP_FEATURES, MEMBERSHIP_FEATURE_LABELS, membershipStatusLabel } from "@ai-drama/domain";
import { SITE_AUTH, SiteAuthError, type RequestHeaders, type SiteAuthState } from "../auth/site-auth";
import { requireOperatorAccess, type CreatorAccessScope } from "../auth/creator-access";
import { ownerAccountFilter } from "../auth/creator-access";

interface AccountResponse {
  setHeader(name: string, value: string): void;
  status(code: number): void;
}

/**
 * Creator-visible plan status and usage ledger (phase 4 skeleton).
 * No payment channel, no locked prices: unpriced amounts stay 「尚未计价」.
 */
@Controller("account")
export class AccountController {
  constructor(
    @Inject(SITE_AUTH) private readonly site: SiteAuthState,
    @Inject(AUTH_WORKSPACE_ID) private readonly workspaceId: string,
    @Optional() @Inject(CREATOR_PLAN_LEDGER_STORE) private readonly plans: CreatorPlanLedgerStore | null = null,
    @Optional() @Inject(MEMBERSHIP_STORE) private readonly membership: MembershipStore | null = null,
  ) {}

  @Get("plan")
  async plan(@Headers() headers: RequestHeaders, @Res({ passthrough: true }) response: AccountResponse) {
    response.setHeader("Cache-Control", "private, no-store");
    const session = this.requireSession(headers);
    if (!this.plans) {
      response.status(200);
      return {
        accountId: session.accountId,
        planName: null,
        unitPriceLabel: "尚未计价",
        remainingLabel: "余量 尚未计价",
        entitlementStatus: null,
        unitPriceAmount: null,
        remainingUnits: null,
      };
    }
    const status = await this.plans.getPlanStatus(this.workspaceId, session.accountId);
    response.status(200);
    return {
      accountId: session.accountId,
      planName: status.plan?.name ?? null,
      planCode: status.plan?.code ?? null,
      unitPriceLabel: formatCreatorPlanUnitPrice({
        unitPriceAmount: status.plan?.unitPriceAmount,
        unitPriceCurrency: status.plan?.unitPriceCurrency,
      }),
      remainingLabel: formatCreatorPlanRemaining({
        remainingUnits: status.remainingUnits,
        unitLabel: status.plan?.unitLabel,
        entitlementStatus: status.entitlementStatus,
        unitPriceAmount: status.plan?.unitPriceAmount,
      }),
      entitlementStatus: status.entitlementStatus,
      unitPriceAmount: status.plan?.unitPriceAmount ?? null,
      unitPriceCurrency: status.plan?.unitPriceCurrency ?? null,
      remainingUnits: status.remainingUnits,
    };
  }

  @Get("ledger")
  async ledger(
    @Headers() headers: RequestHeaders,
    @Query("limit") limit: string | undefined,
    @Res({ passthrough: true }) response: AccountResponse,
  ) {
    response.setHeader("Cache-Control", "private, no-store");
    const session = this.requireSession(headers);
    if (!this.plans) {
      response.status(200);
      return { items: [] as unknown[] };
    }
    const parsedLimit = limit && /^\d+$/.test(limit) ? Number(limit) : 50;
    const items = await this.plans.listLedger(this.workspaceId, session.accountId, parsedLimit);
    response.status(200);
    return {
      items: items.map((entry) => ({
        ...entry,
        display: formatCreatorLedgerRecord({
          accountId: entry.accountId,
          projectId: entry.projectId,
          taskKey: entry.taskKey,
          occurredAt: entry.occurredAt,
          usageSummary: JSON.stringify(entry.usageJson),
          status: entry.status,
          amountDecimal: entry.amountDecimal,
          currency: entry.currency,
          entryKind: entry.entryKind,
        }),
      })),
    };
  }

  /**
   * Confirmed ledger write only. Body.confirmed must be true or nothing is posted.
   * Unconfirmed clicks must not call this with confirmed true; the store also no-ops when confirmed is false.
   */
  @Post("ledger")
  async postLedger(
    @Headers() headers: RequestHeaders,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: AccountResponse,
  ) {
    response.setHeader("Cache-Control", "private, no-store");
    const session = this.requireSession(headers);
    this.auth().authorizeWrite(headers);
    if (!this.plans) throw new SiteAuthError(503, "AUTH_NOT_CONFIGURED");
    const input = typeof body === "object" && body !== null && !Array.isArray(body) ? body as Record<string, unknown> : {};
    const confirmed = input.confirmed === true;
    if (!mayPostCreatorLedgerEntry({ confirmed })) {
      response.status(200);
      return { posted: false, reason: "unconfirmed" };
    }
    const idempotencyKey = typeof input.idempotencyKey === "string" ? input.idempotencyKey : "";
    if (idempotencyKey.length < 1 || idempotencyKey.length > 200) {
      response.status(400);
      return { error: { code: "VALIDATION_ERROR", message: "idempotencyKey required" } };
    }
    const entry = await this.plans.postLedgerEntry({
      workspaceId: this.workspaceId,
      accountId: session.accountId,
      projectId: typeof input.projectId === "string" ? input.projectId : null,
      taskKey: typeof input.taskKey === "string" ? input.taskKey : null,
      entryKind: input.entryKind === "credit" || input.entryKind === "adjustment" ? input.entryKind : "debit",
      usageJson: input.usage ?? {},
      idempotencyKey,
      confirmed: true,
      amountDecimal: typeof input.amountDecimal === "string" || typeof input.amountDecimal === "number"
        ? String(input.amountDecimal) : null,
      currency: typeof input.currency === "string" ? input.currency : null,
    });
    response.status(201);
    return { posted: true, entry };
  }

  @Get("membership")
  async membershipView(@Headers() headers: RequestHeaders, @Res({ passthrough: true }) response: AccountResponse,
    @Query("preflight") preflight?: string) {
    response.setHeader("Cache-Control", "private, no-store");
    const session = this.requireSession(headers);
    if (preflight === "writing") {
      return { denial: session.role === "creator" ? await writingPreflight(this.membership, this.workspaceId, session.accountId) : null };
    }
    if (!this.membership || session.role === "operator" && session.accountId === "open") {
      response.status(200);
      return { status: "none", statusLabel: "未开通", planName: null, startsAt: null, endsAt: null, features: [], ledger: [] };
    }
    const now = new Date();
    const current = await this.membership.currentMembership(this.workspaceId, session.accountId, now);
    const balances = await this.membership.balances(this.workspaceId, session.accountId);
    const plans = await this.membership.listPlans(this.workspaceId);
    const plan = current ? plans.find((item) => item.id === current.planId) : undefined;
    const stamp = now.getTime();
    const status = !current
      ? "none"
      : current.status === "disabled"
        ? "disabled"
        : stamp < Date.parse(current.startsAt) || stamp >= Date.parse(current.endsAt)
          ? "expired"
          : "active";
    const ledger = await this.membership.ledger(this.workspaceId, session.accountId);
    response.status(200);
    return {
      status,
      statusLabel: membershipStatusLabel(status),
      planName: current?.planName ?? null,
      startsAt: current?.startsAt ?? null,
      endsAt: current?.endsAt ?? null,
      sourceLabel: current ? "人工开通" : null,
      features: MEMBERSHIP_FEATURES.map((feature) => ({
        feature,
        label: MEMBERSHIP_FEATURE_LABELS[feature],
        enabled: plan?.features.find((item) => item.feature === feature)?.enabled === true,
        remaining: balances[feature],
      })),
      ledger: ledger.map((row) => ({
        id: row.id,
        summary: `${row.feature ? MEMBERSHIP_FEATURE_LABELS[row.feature] : "额度"} ${row.kind === "debit" ? "占用" : row.kind === "credit" ? "释放" : "调整"} ${Number(row.units)}。${row.reason}`,
        occurredAt: row.occurredAt,
        status: row.status,
      })),
    };
  }

  /** Explicit operator ops listing helper: returns whether the session may open the ops works view. */
  @Get("ops-access")
  opsAccess(@Headers() headers: RequestHeaders, @Res({ passthrough: true }) response: AccountResponse) {
    response.setHeader("Cache-Control", "private, no-store");
    if (this.site.kind === "disabled") {
      response.status(200);
      return { operator: true, opsViewAvailable: true };
    }
    const session = this.auth().session(headers);
    const scope: CreatorAccessScope = {
      kind: "scoped", role: session.role, accountId: session.accountId, username: session.username, opsView: false,
    };
    response.status(200);
    return {
      operator: requireOperatorAccess(scope),
      opsViewAvailable: sessionAllowsStaffPermission({ ...session, required: "review_works" }),
      ownerFilterActive: ownerAccountFilter() !== null,
    };
  }

  private auth() {
    if (this.site.kind !== "enabled") throw new SiteAuthError(503, "AUTH_NOT_CONFIGURED");
    return this.site.auth;
  }

  private requireSession(headers: RequestHeaders) {
    if (this.site.kind === "disabled") {
      return { accountId: "open", role: "operator" as const, username: "open" };
    }
    return this.auth().session(headers);
  }
}
