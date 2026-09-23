import { describe, expect, it } from "vitest";
import {
  adapterHealthResponseSchema,
  mediaWorkerHealthResponseSchema,
  parseReadyHealthResponse,
  readyHealthResponseSchema,
  SERVICE_NAME,
  serviceHealthResponseSchema,
  workerReadyResponseSchema,
} from "./index";

describe("health contracts", () => {
  it("accepts an API live payload", () => {
    const parsed = serviceHealthResponseSchema.parse({
      service: SERVICE_NAME.api,
      status: "ok",
      version: "0.1.0",
      timestamp: "2026-09-23T00:00:00.000Z",
    });
    expect(parsed.service).toBe("api");
  });

  it("accepts a ready payload and rejects secret-shaped dependency details", () => {
    const parsed = readyHealthResponseSchema.parse({
      service: SERVICE_NAME.api,
      status: "degraded",
      timestamp: "2026-09-23T00:00:00.000Z",
      dependencies: {
        postgres: { status: "down" },
        redis: { status: "ok" },
        objectStorage: { status: "down" },
      },
    });
    expect(parsed.dependencies.postgres?.status).toBe("down");
    expect(parseReadyHealthResponse({ status: "ok" })).toBeUndefined();
  });

  it("keeps worker and adapter payloads inside the M1-A skeleton", () => {
    const worker = workerReadyResponseSchema.parse({
      service: "worker",
      status: "ok",
      version: "0.1.0",
      timestamp: "2026-09-23T00:00:00.000Z",
      queueConsumer: "disabled",
      dependencies: {
        postgres: { status: "ok" },
        redis: { status: "ok" },
      },
    });
    const adapter = adapterHealthResponseSchema.parse({
      service: "comfyui-adapter",
      status: "ok",
      mode: "stub",
      comfyuiConfigured: false,
      timestamp: "2026-09-23T00:00:00.000Z",
    });
    const media = mediaWorkerHealthResponseSchema.parse({
      service: "media-worker",
      status: "ok",
      mode: "stub",
      ffmpegRequired: false,
      timestamp: "2026-09-23T00:00:00.000Z",
    });
    expect(worker.queueConsumer).toBe("disabled");
    expect(adapter.mode).toBe("stub");
    expect(media.ffmpegRequired).toBe(false);
  });
});
