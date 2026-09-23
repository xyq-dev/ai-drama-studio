import { describe, expect, it } from "vitest";
import { HealthService } from "./health.service";

describe("HealthService", () => {
  it("reports live without dependency details", () => {
    const service = new HealthService(
      { check: async () => "ok" },
      { check: async () => "ok" },
      { check: async () => "ok" },
    );
    const live = service.live();
    expect(live).toMatchObject({ service: "api", status: "ok", version: "0.1.0" });
    expect(typeof live.timestamp).toBe("string");
  });

  it("returns degraded when any dependency is down and omits secrets", async () => {
    const service = new HealthService(
      { check: async () => "down" },
      { check: async () => "ok" },
      { check: async () => "down" },
    );
    const ready = await service.ready();
    expect(ready.status).toBe("degraded");
    expect(ready.dependencies.postgres).toEqual({ status: "down" });
    expect(ready.dependencies.redis).toEqual({ status: "ok" });
    expect(ready.dependencies.objectStorage).toEqual({ status: "down" });
    expect(JSON.stringify(ready)).not.toContain("password");
    expect(JSON.stringify(ready)).not.toContain("secret");
  });
});
