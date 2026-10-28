import { Global, Logger, Module, type DynamicModule, type MiddlewareConsumer, type NestModule } from "@nestjs/common";
import type { ApiEnv } from "../config/env";
import { AuthController } from "./auth.controller";
import { SITE_AUTH, type SiteAuthState } from "./site-auth";
import { siteAuthFromEnv, siteAuthWarnings } from "./site-auth.config";
import { SiteAuthMiddleware } from "./site-auth.middleware";

/** Registers the login routes and applies the session check to every route of the application. */
@Global()
@Module({})
export class AuthModule implements NestModule {
  static register(env: ApiEnv, state: SiteAuthState = siteAuthFromEnv(env)): DynamicModule {
    for (const warning of siteAuthWarnings(env, state)) Logger.warn(warning, "SiteAuth");
    return {
      module: AuthModule,
      controllers: [AuthController],
      providers: [{ provide: SITE_AUTH, useValue: state }, SiteAuthMiddleware],
      exports: [SITE_AUTH],
    };
  }

  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(SiteAuthMiddleware).forRoutes("*");
  }
}
