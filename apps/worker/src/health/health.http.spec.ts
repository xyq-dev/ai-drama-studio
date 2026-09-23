import "reflect-metadata";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { afterEach, describe, expect, it } from "vitest";
import { HealthController } from "./health.controller";
import { HealthService } from "./health.service";

describe("worker health routes", () => {
  let app: INestApplication | undefined;

  afterEach(async () => {
    if (app) {
      await app.close();
      app = undefined;
    }
  });

  it("serves /health/live and /health/ready", async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [
        {
          provide: HealthService,
          useValue: {
            live: () => ({
              service: "worker",
              status: "ok",
              version: "0.1.0",
              timestamp: "2026-09-23T00:00:00.000Z",
              queueConsumer: "disabled",
            }),
            ready: async () => ({
              service: "worker",
              status: "degraded",
              version: "0.1.0",
              timestamp: "2026-09-23T00:00:00.000Z",
              queueConsumer: "disabled",
              dependencies: {
                postgres: { status: "down" },
                redis: { status: "down" },
              },
            }),
          },
        },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    await app.listen(0, "127.0.0.1");
    const base = await app.getUrl();
    const live = await fetch(`${base}/health/live`);
    expect(live.status).toBe(200);
    const ready = await fetch(`${base}/health/ready`);
    expect(ready.status).toBe(503);
    const body: unknown = await ready.json();
    expect(JSON.stringify(body)).toContain("queueConsumer");
    expect(JSON.stringify(body)).not.toContain("secret");
  });
});
