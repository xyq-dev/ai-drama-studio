import { chmodSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Global, Logger, Module, type DynamicModule, type MiddlewareConsumer, type NestModule } from "@nestjs/common";
import {
  CreatorAccountStore,
  CreatorPlanLedgerStore,
  createPostgresPool,
  type PostgresPool,
} from "@ai-drama/database";
import type { ApiEnv } from "../config/env";
import { AccountController } from "../account/account.controller";
import { AdminCreatorsController } from "../admin/admin-creators.controller";
import { AdminMembershipController } from "../admin/membership.controller";
import { AdminStaffController } from "../admin/staff.controller";
import { STAFF_ACCESS_SERVICE, StaffAccessService } from "../admin/staff-access.service";
import { PostgresStaffRepository } from "../admin/staff-repository";
import { hashPassword, parsePasswordHash, verifyPassword } from "./password-hash";
import { MEMBERSHIP_STORE, PostgresMembershipStore } from "../membership/membership-store";
import { noteOperation, operationJournal, setOperationJournal, OperationLogStore } from "../admin/operation-log-store";
import { AuthController } from "./auth.controller";
import { AUTH_POOL, AUTH_WORKSPACE_ID, CREATOR_ACCOUNT_STORE, CREATOR_PLAN_LEDGER_STORE } from "./auth.tokens";
import { SITE_AUTH, type SiteAuthState } from "./site-auth";
import { siteAuthFromEnv, siteAuthWarnings } from "./site-auth.config";
import { SiteAuthMiddleware } from "./site-auth.middleware";

export { AUTH_POOL, AUTH_WORKSPACE_ID } from "./auth.tokens";

/** Registers the login routes and applies the session check to every route of the application. */
@Global()
@Module({})
export class AuthModule implements NestModule {
  static register(env: ApiEnv, state?: SiteAuthState): DynamicModule {
    let authPool: PostgresPool | null = null;
    let creators: CreatorAccountStore | null = null;
    let plans: CreatorPlanLedgerStore | null = null;
    // When callers pass an explicit SiteAuthState (HTTP specs), keep that fixture and skip the DB directory.
    if (state === undefined && env.SITE_AUTH_ENABLED === "true" && env.DATABASE_URL) {
      authPool = createPostgresPool({
        connectionString: env.DATABASE_URL,
        connectionTimeoutMs: env.HEALTH_CHECK_TIMEOUT_MS ?? 2_000,
        statementTimeoutMs: 15_000,
        queryTimeoutMs: 15_000,
      });
      creators = new CreatorAccountStore(authPool);
      plans = new CreatorPlanLedgerStore(authPool);
    }
    const resolved = state ?? siteAuthFromEnv(env, { creators });
    for (const warning of siteAuthWarnings(env, resolved)) Logger.warn(warning, "SiteAuth");
    const workspaceId = env.APP_WORKSPACE_ID ?? "00000000-0000-4000-8000-000000000099";
    let staff: StaffAccessService | null = null;
    let membership: PostgresMembershipStore | null = null;
    if (authPool && resolved.kind === "enabled" && env.SITE_AUTH_PASSWORD_HASH) {
      membership = new PostgresMembershipStore(authPool);
      staff = new StaffAccessService({
        workspaceId,
        repository: new PostgresStaffRepository(authPool),
        publicOrigin: resolved.auth.publicOrigin,
        envUsername: resolved.auth.username,
        envPasswordHash: env.SITE_AUTH_PASSWORD_HASH,
        hashPassword: (password, cheap) => hashPassword(password, cheap
          ? { log2N: 15, r: 8, p: 1, saltBytes: 16, keyBytes: 32 }
          : undefined),
        verifyPassword: async (password, encoded) => {
          const parsed = parsePasswordHash(encoded);
          return parsed ? verifyPassword(password, parsed) : false;
        },
        sessions: {
          sync: (id, access) => resolved.auth.syncStaff(id, access),
          revokeAccount: (id) => resolved.auth.revokeAccount(id),
          list: (id) => resolved.auth.listStaffSessions(id),
          revokeOne: (id, publicId) => resolved.auth.revokeStaffSession(id, publicId),
        },
        audit: (entry, forbidden) => noteOperation({ ...entry, source: "管理后台 /admin/users" }, forbidden),
      });
      resolved.auth.setStaffDirectory(staff.loginDirectory());
      if (!operationJournal()) {
        const logDirectory = join(tmpdir(), `ads-operation-log-${workspaceId}`);
        mkdirSync(logDirectory, { recursive: true, mode: 0o700 });
        try {
          chmodSync(logDirectory, 0o700);
        } catch {
          // Windows has no POSIX mode bits. The store accepts that platform.
        }
        setOperationJournal(new OperationLogStore(join(logDirectory, "operation-log.json")));
      }
      void staff.ensureEnvSuperAdmin().catch((error: unknown) => Logger.warn(String(error), "StaffAccess"));
    }
    return {
      module: AuthModule,
      controllers: [AuthController, AccountController, AdminCreatorsController, AdminStaffController, AdminMembershipController],
      providers: [
        { provide: SITE_AUTH, useValue: resolved },
        { provide: CREATOR_ACCOUNT_STORE, useValue: creators },
        { provide: CREATOR_PLAN_LEDGER_STORE, useValue: plans },
        { provide: AUTH_WORKSPACE_ID, useValue: workspaceId },
        { provide: AUTH_POOL, useValue: authPool },
        { provide: STAFF_ACCESS_SERVICE, useValue: staff },
        { provide: MEMBERSHIP_STORE, useValue: membership },
        SiteAuthMiddleware,
      ],
      exports: [SITE_AUTH, CREATOR_ACCOUNT_STORE, CREATOR_PLAN_LEDGER_STORE, AUTH_WORKSPACE_ID, STAFF_ACCESS_SERVICE, MEMBERSHIP_STORE],
    };
  }

  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(SiteAuthMiddleware).forRoutes("*");
  }
}
