import { describe, expect, it } from "vitest";
import { loadStatusView, unavailableView } from "../lib/load-status";

describe("status data", () => {
  it("builds an unavailable view when the page cannot reach the API", () => {
    const view = unavailableView("test", "2026-09-23T00:00:00.000Z");
    expect(view.webStatus).toBe("ok");
    expect(view.apiStatus).toBe("unavailable");
    expect(view.postgres).toBe("unknown");
    expect(view.checkedAt).toBe("2026-09-23T00:00:00.000Z");
  });

  it("maps a degraded API response and hides transport failures", async () => {
    const degraded = await loadStatusView({
      baseUrl: "http://127.0.0.1:3001",
      environment: "test",
      now: () => new Date("2026-09-23T01:00:00.000Z"),
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            service: "api",
            status: "degraded",
            timestamp: "2026-09-23T01:00:00.000Z",
            dependencies: {
              postgres: { status: "down" },
              redis: { status: "ok" },
              objectStorage: { status: "down" },
            },
          }),
          { status: 503, headers: { "content-type": "application/json" } },
        ),
    });
    expect(degraded.apiStatus).toBe("degraded");
    expect(degraded.postgres).toBe("down");
    expect(degraded.redis).toBe("ok");
    expect(degraded.objectStorage).toBe("down");

    const failed = await loadStatusView({
      baseUrl: "http://127.0.0.1:3001",
      environment: "test",
      now: () => new Date("2026-09-23T01:00:00.000Z"),
      fetchImpl: async () => {
        throw new Error("connect ECONNREFUSED password=super-secret-password");
      },
    });
    expect(failed.apiStatus).toBe("unavailable");
    expect(JSON.stringify(failed)).not.toContain("super-secret-password");
  });
});
