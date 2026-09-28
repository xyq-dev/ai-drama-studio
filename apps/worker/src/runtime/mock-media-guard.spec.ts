import { expect, it } from "vitest";
import { startQueueRuntime } from "./start-runtime";

it("rejects Mock local storage at the public runtime entry in production", async () => {
  const previous = process.env.NODE_ENV;
  try {
    process.env.NODE_ENV = "production";
    await expect(startQueueRuntime({
      databaseUrl: "postgresql://unused:unused@localhost/unused",
      redisUrl: "redis://localhost:6379",
      mockObjectDir: "/tmp/mock-media",
    })).rejects.toThrow(/forbidden in production/i);
  } finally {
    if (previous === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
  }
});
