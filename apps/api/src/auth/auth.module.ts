import { Global, Logger, Module, type DynamicModule, type MiddlewareConsumer, type NestModule } from "@nestjs/common";
import {
  CreatorAccountStore,
  CreatorPlanLedgerStore,
  createPostgresPool,
  type PostgresPool,
} from "@ai-drama/database";
import type { ApiEnv } from "../config/env";
import { AccountController } from "../account/account.controller";
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
    return {
      module: AuthModule,
      controllers: [AuthController, AccountController],
      providers: [
        { provide: SITE_AUTH, useValue: resolved },
        { provide: CREATOR_ACCOUNT_STORE, useValue: creators },
        { provide: CREATOR_PLAN_LEDGER_STORE, useValue: plans },
        { provide: AUTH_WORKSPACE_ID, useValue: env.APP_WORKSPACE_ID ?? "00000000-0000-4000-8000-000000000099" },
        { provide: AUTH_POOL, useValue: authPool },
        SiteAuthMiddleware,
      ],
      exports: [SITE_AUTH, CREATOR_ACCOUNT_STORE, CREATOR_PLAN_LEDGER_STORE, AUTH_WORKSPACE_ID],
    };
  }

  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(SiteAuthMiddleware).forRoutes("*");
  }
}
