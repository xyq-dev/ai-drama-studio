import { describe, expect, it } from "vitest";
import { M1A_PROVIDER_BOUNDARY } from "./index";

describe("provider boundary", () => {
  it("does not claim an adapter is implemented", () => {
    expect(M1A_PROVIDER_BOUNDARY.stage).toBe("m1a");
    expect(M1A_PROVIDER_BOUNDARY.adaptersImplemented).toBe(false);
  });
});
