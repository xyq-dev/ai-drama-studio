import { describe, expect, it } from "vitest";
import { resolveApiUpstream } from "./api-upstream";

describe("resolveApiUpstream", () => {
  it("defaults to the local API origin", () => {
    expect(resolveApiUpstream(undefined)).toBe("http://127.0.0.1:3001");
    expect(resolveApiUpstream("  ")).toBe("http://127.0.0.1:3001");
  });

  it("keeps a validated origin and drops a path", () => {
    expect(resolveApiUpstream("http://127.0.0.1:3001/api/v1")).toBe("http://127.0.0.1:3001");
  });

  it("rejects credentials and non-http schemes", () => {
    expect(() => resolveApiUpstream("http://user:pass@127.0.0.1:3001")).toThrow(/credentials/);
    expect(() => resolveApiUpstream("ftp://127.0.0.1")).toThrow(/http/);
  });
});
