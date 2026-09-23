import { describe, expect, it } from "vitest";
import { WORKER_BOOT_LOGS } from "../version";
import { HealthService } from "./health.service";

describe("worker health", () => {
  it("states that the queue consumer is disabled", async () => {
    const service = new HealthService({ check: async () => "ok" }, { check: async () => "down" });
    expect(service.live().queueConsumer).toBe("disabled");
    expect(WORKER_BOOT_LOGS).toEqual(["worker skeleton", "queue consumer disabled in M1-A"]);
    const ready = await service.ready();
    expect(ready.status).toBe("degraded");
    expect(ready.queueConsumer).toBe("disabled");
    expect(ready.dependencies.redis).toEqual({ status: "down" });
    expect(JSON.stringify(ready)).not.toContain("postgresql://");
  });
});
