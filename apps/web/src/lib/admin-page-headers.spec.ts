import { describe, expect, it } from "vitest";
import nextConfig from "../../next.config";

const PRIVATE = [
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Cache-Control", value: "no-store" },
];

describe("administrator and login page security headers", () => {
  it("denies framing and caching on the login page and the administrator route tree only", async () => {
    expect(await nextConfig.headers?.()).toEqual([
      { source: "/login", headers: PRIVATE },
      { source: "/admin/:path*", headers: PRIVATE },
    ]);
  });
});
