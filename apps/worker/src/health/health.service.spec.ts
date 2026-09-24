import { describe, expect, it } from "vitest";
import { WORKER_BOOT_LOGS } from "../version";
import { HealthService } from "./health.service";

describe("worker health", () => {
  it("reports postgres, redis, and queue runtime without connection details", async () => {
    const service = new HealthService(
      { check: async () => "ok" },
      { check: async () => "down" },
      { check: async () => "down" },
    );
    expect(service.live()).not.toHaveProperty("queueConsumer");
    expect(WORKER_BOOT_LOGS).toEqual(["worker runtime", "queue consumer enabled"]);
    const ready = await service.ready();
    expect(ready.status).toBe("degraded");
    expect(ready.dependencies.redis).toEqual({ status: "down" });
    expect(ready.dependencies.queue).toEqual({ status: "down" });
    expect(JSON.stringify(ready)).not.toContain("postgresql://");
    expect(JSON.stringify(ready)).not.toContain("redis://");
  });
});
