import { Body, Controller, Get, Headers, Inject, Optional, Param, Post, Put, Res } from "@nestjs/common";
import {
  MEMBERSHIP_FEATURES,
  addCalendarMonths,
  isMembershipFeature,
  membershipStatusLabel,
  type MembershipFeature,
} from "@ai-drama/domain";
import { SITE_AUTH, SiteAuthError, type RequestHeaders, type SiteAuthState } from "../auth/site-auth";
import { setAdminResponseHeaders } from "./admin-auth";
import { StaffAccessError, assertStaffPermission } from "./staff-access.service";
import { MEMBERSHIP_STORE, type MembershipStore } from "../membership/membership-store";
import { AUTH_WORKSPACE_ID } from "../auth/auth.tokens";

interface AdminResponse {
  setHeader(name: string, value: string): void;
  status(code: number): void;
}

@Controller("admin/membership")
export class AdminMembershipController {
  constructor(
    @Optional() @Inject(MEMBERSHIP_STORE) private readonly store: MembershipStore | null,
    @Optional() @Inject(SITE_AUTH) private readonly site: SiteAuthState | null,
    @Inject(AUTH_WORKSPACE_ID) private readonly workspaceId: string,
  ) {}

  @Get("plans")
  plans(@Headers() headers: RequestHeaders, @Res({ passthrough: true }) response: AdminResponse) {
    return this.send(response, async () => {
      this.ready(headers, "grant_membership");
      return { items: await this.storeOrThrow().listPlans(this.workspaceId) };
    });
  }

  @Put("plans")
  savePlan(@Headers() headers: RequestHeaders, @Body() body: unknown, @Res({ passthrough: true }) response: AdminResponse) {
    return this.send(response, async () => {
      const session = this.ready(headers, "grant_membership");
      this.write(headers);
      const input = record(body);
      const code = text(input.code).trim();
      const name = text(input.name).trim();
      if (!/^[a-z0-9_-]{1,64}$/u.test(code) || name.length < 1) {
        throw new StaffAccessError(400, "PLAN_INVALID", "请填写套餐代号和名称。价格和额度留空表示尚未配置。");
      }
      const amount = text(input.unitPriceAmount).trim();
      const currency = text(input.unitPriceCurrency).trim().toUpperCase();
      if ((amount.length === 0) !== (currency.length === 0)) {
        throw new StaffAccessError(400, "PLAN_INVALID", "单价和币种需要一起填写，或都留空。");
      }
      const existing = (await this.storeOrThrow().listPlans(this.workspaceId)).find((plan) => plan.code === code);
      const supplied = record(input.features);
      const features = MEMBERSHIP_FEATURES.map((feature) => {
        if (input.features == null || supplied[feature] == null) {
          const kept = existing?.features.find((item) => item.feature === feature);
          return { feature, enabled: kept?.enabled === true, includedUnits: kept?.includedUnits ?? null };
        }
        const raw = record(supplied[feature]);
        const units = text(raw.includedUnits).trim();
        return {
          feature,
          enabled: raw.enabled === true,
          includedUnits: units.length === 0 ? null : Number(units),
        };
      });
      if (features.some((feature) => feature.includedUnits != null && !Number.isFinite(feature.includedUnits))) {
        throw new StaffAccessError(400, "PLAN_INVALID", "额度请填写数字，或留空。");
      }
      return this.storeOrThrow().savePlan(this.workspaceId, {
        code,
        name,
        description: text(input.description),
        unitPriceAmount: amount.length === 0 ? null : amount,
        unitPriceCurrency: currency.length === 0 ? null : currency,
        active: input.active !== false,
        features,
      }).then((plan) => {
        void session;
        return plan;
      });
    });
  }

  @Get("members")
  members(@Headers() headers: RequestHeaders, @Res({ passthrough: true }) response: AdminResponse) {
    return this.send(response, async () => {
      this.ready(headers, "grant_membership");
      return { items: await this.storeOrThrow().listMemberships(this.workspaceId) };
    });
  }

  @Post("grants")
  grant(@Headers() headers: RequestHeaders, @Body() body: unknown, @Res({ passthrough: true }) response: AdminResponse) {
    return this.send(response, async () => {
      const session = this.ready(headers, "grant_membership");
      this.write(headers);
      const input = record(body);
      const reason = text(input.reason).trim();
      const months = Number(input.months);
      if (reason.length < 1 || !Number.isInteger(months) || months < 1 || months > 36) {
        throw new StaffAccessError(400, "GRANT_INVALID", "请填写开通原因，以及 1 到 36 的开通月数。");
      }
      const startsAt = new Date();
      const granted = await this.storeOrThrow().grant(this.workspaceId, {
        accountId: text(input.accountId),
        planId: text(input.planId),
        startsAt,
        endsAt: addCalendarMonths(startsAt, months),
        reason,
        grantedBy: session.staffId ?? session.username,
      });
      return { ...granted, sourceLabel: "人工开通", paymentOrder: null };
    });
  }

  @Post(":id/status")
  status(@Headers() headers: RequestHeaders, @Param("id") id: string, @Body() body: unknown, @Res({ passthrough: true }) response: AdminResponse) {
    return this.send(response, async () => {
      this.ready(headers, "grant_membership");
      this.write(headers);
      const next = record(body).status === "disabled" ? "disabled" : "active";
      await this.storeOrThrow().setStatus(this.workspaceId, id, next);
      return { ok: true, statusLabel: membershipStatusLabel(next === "disabled" ? "disabled" : "active") };
    });
  }

  @Post("adjust")
  adjust(@Headers() headers: RequestHeaders, @Body() body: unknown, @Res({ passthrough: true }) response: AdminResponse) {
    return this.send(response, async () => {
      const session = this.ready(headers, "adjust_quota");
      this.write(headers);
      const input = record(body);
      const feature = text(input.feature);
      const reason = text(input.reason).trim();
      const delta = Number(input.delta);
      if (!isMembershipFeature(feature) || reason.length < 1 || !Number.isFinite(delta) || delta === 0) {
        throw new StaffAccessError(400, "ADJUST_INVALID", "请选择功能、填写调整数量和原因。");
      }
      const remaining = await this.storeOrThrow().adjust(this.workspaceId, {
        accountId: text(input.accountId),
        feature: feature as MembershipFeature,
        delta,
        reason,
        actorId: session.staffId ?? session.username,
      });
      return { remaining, source: "manual" };
    });
  }

  private storeOrThrow(): MembershipStore {
    if (!this.store) throw new SiteAuthError(503, "AUTH_NOT_CONFIGURED");
    return this.store;
  }

  private ready(headers: RequestHeaders, permission: "grant_membership" | "adjust_quota") {
    if (this.site?.kind !== "enabled") throw new SiteAuthError(503, "AUTH_NOT_CONFIGURED");
    const session = this.site.auth.session(headers);
    if (session.role !== "operator") throw new SiteAuthError(401, "AUTH_REQUIRED");
    assertStaffPermission(session, permission);
    return session;
  }

  private write(headers: RequestHeaders): void {
    if (this.site?.kind === "enabled") this.site.auth.authorizeWrite(headers);
  }

  private async send(response: AdminResponse, work: () => unknown | Promise<unknown>) {
    setAdminResponseHeaders(response);
    try {
      const body = await work();
      response.status(200);
      return body;
    } catch (cause) {
      if (cause instanceof SiteAuthError || cause instanceof StaffAccessError) {
        response.status(cause.status);
        return { error: { code: cause.code, message: cause.message } };
      }
      response.status(503);
      return { error: { code: "MEMBERSHIP_UNAVAILABLE", message: "暂时无法处理会员。本次没有开通，也没有生成订单。" } };
    }
  }
}

function record(body: unknown): Record<string, unknown> {
  return typeof body === "object" && body !== null && !Array.isArray(body) ? body as Record<string, unknown> : {};
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}
