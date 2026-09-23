import "reflect-metadata";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { afterEach, describe, expect, it } from "vitest";
import { loadAdapterEnv } from "../config/env";
import { HealthModule } from "./health.module";

describe("adapter routes", () => {
  let app: INestApplication | undefined;

  afterEach(async () => {
    if (app) {
      await app.close();
      app = undefined;
    }
  });

  it("returns the stub payload on live and ready", async () => {
    const env = loadAdapterEnv({ COMFYUI_MODE: "stub", COMFYUI_BASE_URL: "" });
    const moduleRef = await Test.createTestingModule({
      imports: [HealthModule.register(env)],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    await app.listen(0, "127.0.0.1");
    const base = await app.getUrl();
    const ready = await fetch(`${base}/health/ready`);
    expect(ready.status).toBe(200);
    const body: unknown = await ready.json();
    expect(body).toMatchObject({
      service: "comfyui-adapter",
      status: "ok",
      mode: "stub",
      comfyuiConfigured: false,
    });
  });
});
