import { describe, expect, it } from "vitest";
import {
  asProof,
  operatorAllowed,
  operatorConfigured,
  platformCreationAllowed,
  type OperatorProof,
} from "./operator-access";

const TOKEN = "synthetic-operator-token-never-live";

describe("operatorAllowed vs platformCreationAllowed", () => {
  it("does not treat an arbitrary valid session as a site operator", () => {
    const creator: OperatorProof = { session: true, role: "creator", token: undefined };
    const operator: OperatorProof = { session: true, role: "operator", token: undefined };
    const policy = { siteOperator: true, operatorToken: null };

    expect(operatorAllowed(policy, creator)).toBe(false);
    expect(operatorAllowed(policy, operator)).toBe(true);
    expect(platformCreationAllowed(policy, creator)).toBe(true);
    expect(platformCreationAllowed(policy, operator)).toBe(true);
    expect(operatorConfigured(policy)).toBe(true);
  });

  it("still accepts the server-side operator token when site login is off", () => {
    const policy = { siteOperator: false, operatorToken: TOKEN };
    expect(operatorAllowed(policy, TOKEN)).toBe(true);
    expect(platformCreationAllowed(policy, TOKEN)).toBe(true);
    expect(operatorAllowed(policy, "wrong")).toBe(false);
    expect(operatorAllowed(policy, asProof({ session: true, role: "operator", token: undefined }))).toBe(false);
  });
});
