import { Body, Controller, Get, Headers, Inject, Optional, Param, Post, Res } from "@nestjs/common";
import type { StaffPermission } from "@ai-drama/domain";
import { STAFF_ACCESS_SERVICE, StaffAccessError, assertStaffPermission, type StaffAccessService, type StaffActor } from "./staff-access.service";
import { SITE_AUTH, SiteAuthError, type RequestHeaders, type SiteAuthState } from "../auth/site-auth";
import { setAdminResponseHeaders } from "./admin-auth";

interface AdminResponse {
  setHeader(name: string, value: string): void;
  status(code: number): void;
}

@Controller("admin/staff")
export class AdminStaffController {
  constructor(
    @Optional() @Inject(STAFF_ACCESS_SERVICE) private readonly staff: StaffAccessService | null,
    @Optional() @Inject(SITE_AUTH) private readonly site: SiteAuthState | null,
  ) {}

  @Get()
  list(@Headers() headers: RequestHeaders, @Res({ passthrough: true }) response: AdminResponse) {
    return this.send(response, async () => {
      const { service, actor } = this.ready(headers, "manage_staff");
      const body = await service.list();
      return {
        currentStaffId: actor.id,
        requiresSecondFactor: body.staff.some(account => account.id === actor.id && account.totpEnabled),
        roles: body.roles.map((role) => ({ id: role.id, code: role.code, name: role.name, builtIn: role.builtIn, permissions: role.permissions })),
        staff: body.staff.map((account) => ({
          id: account.id,
          username: account.username,
          displayName: account.displayName,
          status: account.status,
          statusLabel: account.statusLabel,
          roleId: account.roleId,
          roleName: account.roleName,
          lastLoginAt: account.lastLoginAt,
          permissions: account.permissions,
        })),
      };
    });
  }

  @Post("invites")
  invite(@Headers() headers: RequestHeaders, @Body() body: unknown, @Res({ passthrough: true }) response: AdminResponse) {
    return this.send(response, async () => {
      const { service, actor } = this.ready(headers, "manage_staff");
      this.write(headers);
      const input = record(body);
      return service.invite(actor, {
        username: text(input.username),
        displayName: text(input.displayName),
        roleId: text(input.roleId),
        currentPassword: optional(input.currentPassword),
        totpCode: optional(input.totpCode),
      });
    });
  }

  @Post("roles")
  createRole(@Headers() headers: RequestHeaders, @Body() body: unknown, @Res({ passthrough: true }) response: AdminResponse) {
    return this.send(response, async () => {
      const { service, actor } = this.ready(headers, "manage_staff");
      this.write(headers);
      const input = record(body);
      return service.saveRole(actor, { name: text(input.name), permissions: array(input.permissions) });
    });
  }

  @Post("roles/:id")
  updateRole(@Headers() headers: RequestHeaders, @Param("id") id: string, @Body() body: unknown, @Res({ passthrough: true }) response: AdminResponse) {
    return this.send(response, async () => {
      const { service, actor } = this.ready(headers, "manage_staff");
      this.write(headers);
      const input = record(body);
      return service.saveRole(actor, { id, name: text(input.name), permissions: array(input.permissions) });
    });
  }

  @Post("password")
  password(@Headers() headers: RequestHeaders, @Body() body: unknown, @Res({ passthrough: true }) response: AdminResponse) {
    return this.send(response, async () => {
      const { service, session } = this.ready(headers);
      this.write(headers);
      const input = record(body);
      await service.changePassword(session.staffId ?? session.accountId, text(input.currentPassword), text(input.nextPassword));
      return { ok: true };
    });
  }

  @Post("totp/start")
  totpStart(@Headers() headers: RequestHeaders, @Body() body: unknown, @Res({ passthrough: true }) response: AdminResponse) {
    return this.send(response, async () => {
      const { service, session } = this.ready(headers);
      this.write(headers);
      const input = record(body);
      return service.beginTotp(session.staffId ?? session.accountId, text(input.currentPassword), optional(input.totpCode));
    });
  }

  @Post("totp/confirm")
  totpConfirm(@Headers() headers: RequestHeaders, @Body() body: unknown, @Res({ passthrough: true }) response: AdminResponse) {
    return this.send(response, async () => {
      const { service, session } = this.ready(headers);
      this.write(headers);
      return service.confirmTotp(session.staffId ?? session.accountId, text(record(body).code));
    });
  }

  @Post(":id/revoke-invite")
  revoke(@Headers() headers: RequestHeaders, @Param("id") id: string, @Res({ passthrough: true }) response: AdminResponse) {
    return this.send(response, async () => {
      const { service, actor } = this.ready(headers, "manage_staff");
      this.write(headers);
      await service.revokeInvite(actor, id);
      return { ok: true };
    });
  }

  @Post(":id/resend-invite")
  resend(@Headers() headers: RequestHeaders, @Param("id") id: string, @Res({ passthrough: true }) response: AdminResponse) {
    return this.send(response, async () => {
      const { service, actor } = this.ready(headers, "manage_staff");
      this.write(headers);
      return service.resendInvite(actor, id);
    });
  }

  @Post(":id/status")
  status(@Headers() headers: RequestHeaders, @Param("id") id: string, @Body() body: unknown, @Res({ passthrough: true }) response: AdminResponse) {
    return this.send(response, async () => {
      const { service, actor } = this.ready(headers, "manage_staff");
      this.write(headers);
      const input = record(body);
      const next = input.status === "disabled" ? "disabled" : "active";
      await service.setStatus(actor, id, next, { currentPassword: optional(input.currentPassword), totpCode: optional(input.totpCode) });
      return { ok: true };
    });
  }

  @Get(":id/sessions")
  sessions(@Headers() headers: RequestHeaders, @Param("id") id: string, @Res({ passthrough: true }) response: AdminResponse) {
    return this.send(response, () => {
      const { service, session } = this.ready(headers);
      if (session.staffId && session.staffId !== id) assertStaffPermission(session, "manage_staff");
      return { items: service.listSessions(id) };
    });
  }

  @Post(":id/sessions/:publicId/revoke")
  revokeSession(
    @Headers() headers: RequestHeaders,
    @Param("id") id: string,
    @Param("publicId") publicId: string,
    @Res({ passthrough: true }) response: AdminResponse,
  ) {
    return this.send(response, async () => {
      const { service, actor } = this.ready(headers);
      this.write(headers);
      await service.revokeSession(actor, id, publicId);
      return { ok: true };
    });
  }

  @Post(":id")
  update(@Headers() headers: RequestHeaders, @Param("id") id: string, @Body() body: unknown, @Res({ passthrough: true }) response: AdminResponse) {
    return this.send(response, async () => {
      const { service, actor } = this.ready(headers, "manage_staff");
      this.write(headers);
      const input = record(body);
      await service.updateStaff(actor, id, {
        displayName: optional(input.displayName),
        roleId: optional(input.roleId),
        currentPassword: optional(input.currentPassword),
        totpCode: optional(input.totpCode),
      });
      return { ok: true };
    });
  }

  private ready(headers: RequestHeaders, permission?: StaffPermission) {
    if (!this.staff || this.site?.kind !== "enabled") throw new SiteAuthError(503, "AUTH_NOT_CONFIGURED");
    const session = this.site.auth.session(headers);
    if (session.role !== "operator") throw new SiteAuthError(401, "AUTH_REQUIRED");
    if (permission) assertStaffPermission(session, permission);
    const actor: StaffActor = { id: session.staffId ?? session.accountId, username: session.username, permissions: session.permissions };
    return { service: this.staff, session, actor };
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
      return { error: { code: "STAFF_UNAVAILABLE", message: "暂时无法处理后台人员。本次没有改动。" } };
    }
  }
}

function record(body: unknown): Record<string, unknown> {
  return typeof body === "object" && body !== null && !Array.isArray(body) ? body as Record<string, unknown> : {};
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function optional(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function array(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}
