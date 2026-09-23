import "reflect-metadata";
import { Test } from "@nestjs/testing";
import { afterEach, describe, expect, it } from "vitest";
import type { INestApplication } from "@nestjs/common";
import { HealthController } from "./health.controller";
import { HealthService } from "./health.service";

describe("health routes", () => {
  let app: INestApplication | undefined;

  afterEach(async () => {
    if (app) {
      await app.close();
      app = undefined;
    }
  });

  it("serves live 200 and ready 503 without secret fields", async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [
        {
          provide: HealthService,
          useValue: {
            live: () => ({
              service: "api",
              status: "ok",
              version: "0.1.0",
              timestamp: "2026-09-23T00:00:00.000Z",
            }),
            ready: async () => ({
              service: "api",
              status: "degraded",
              timestamp: "2026-09-23T00:00:00.000Z",
              dependencies: {
                postgres: { status: "down" },
                redis: { status: "down" },
                objectStorage: { status: "down" },
              },
            }),
          },
        },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix("api/v1");
    await app.init();
    await app.listen(0, "127.0.0.1");
    const base = await app.getUrl();

    const live = await fetch(`${base}/api/v1/health/live`);
    expect(live.status).toBe(200);
    const liveBody: unknown = await live.json();
    expect(liveBody).toMatchObject({ service: "api", status: "ok" });

    const ready = await fetch(`${base}/api/v1/health/ready`);
    expect(ready.status).toBe(503);
    const readyBody: unknown = await ready.json();
    const serialized = JSON.stringify(readyBody);
    expect(serialized).toContain("\"objectStorage\"");
    expect(serialized).not.toContain("dev-only-change-me");
    expect(serialized).not.toContain("postgres://");
  });
});
