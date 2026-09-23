import { describe, expect, it } from "vitest";
import { DomainError } from "./index";

describe("DomainError", () => {
  it("keeps a stable code without modeling jobs", () => {
    const error = new DomainError("NOT_READY", "dependency unavailable");
    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe("NOT_READY");
    expect(error.name).toBe("DomainError");
  });
});
