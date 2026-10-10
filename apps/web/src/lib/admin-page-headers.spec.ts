import { describe, expect, it } from "vitest";
import nextConfig from "../../next.config";

describe("administrator page security headers", () => {
  it("denies framing and caching only on the administrator route tree", async () => {
    expect(await nextConfig.headers?.()).toEqual([{
      source: "/admin/:path*",
      headers: [
        { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
        { key: "X-Frame-Options", value: "DENY" },
        { key: "Cache-Control", value: "no-store" },
      ],
    }]);
  });
});
