import { describe, expect, it } from "vitest";
import { adminLimitsUpdateSchema, adminProviderKeySchema, adminProviderUpdateSchema } from "./admin-models";

const provider = { expectedRevision: 0, models: ["test-model:2026"], secretAction: "keep" };
const limits = { expectedRevision: 0, defaultProvider: "qwen", maxCallsPerDay: 8, maxActiveRuns: 1 };

describe("admin model configuration request contracts", () => {
  it("requires explicit keep/replace/clear operations, including keeping an empty model list", () => {
    expect(adminProviderUpdateSchema.safeParse(provider).success).toBe(true);
    expect(adminProviderUpdateSchema.safeParse({ ...provider, secretAction: "replace", apiKey: "secret-value" }).success).toBe(true);
    expect(adminProviderUpdateSchema.safeParse({ ...provider, secretAction: "clear", models: [] }).success).toBe(true);
    expect(adminProviderUpdateSchema.safeParse({ ...provider, secretAction: "replace" }).success).toBe(false);
    expect(adminProviderUpdateSchema.safeParse({ ...provider, secretAction: "keep", apiKey: "secret-value" }).success).toBe(false);
    expect(adminProviderUpdateSchema.safeParse({ ...provider, secretAction: "clear", apiKey: "secret-value" }).success).toBe(false);
    expect(adminProviderUpdateSchema.safeParse({ expectedRevision: 0, models: [] }).success).toBe(false);
  });

  it.each([-1, 0.5, Number.MAX_SAFE_INTEGER + 1, "0", null, undefined])("refuses invalid CAS revision %s", (expectedRevision) => {
    expect(adminProviderUpdateSchema.safeParse({ ...provider, expectedRevision }).success).toBe(false);
    expect(adminLimitsUpdateSchema.safeParse({ ...limits, expectedRevision }).success).toBe(false);
  });

  it.each(["enabled", "operatorToken", "apiKey", "NODE_ENV", "budgetCny", "__proto__"])("does not allow injecting %s into limits", (field) => {
    expect(adminLimitsUpdateSchema.safeParse({ ...limits, [field]: "injected" }).success).toBe(false);
  });

  it.each(["enabled", "operatorToken", "provider", "NODE_ENV", "budgetCny"])("does not allow injecting %s into provider settings", (field) => {
    expect(adminProviderUpdateSchema.safeParse({ ...provider, [field]: "injected" }).success).toBe(false);
  });

  it("rejects unsafe model strings, excessive lists, and oversized fields", () => {
    for (const model of ["", "model name", "https://example.test/model", "model\nheader", "模型", "x".repeat(129)]) {
      expect(adminProviderUpdateSchema.safeParse({ ...provider, models: [model] }).success).toBe(false);
    }
    expect(adminProviderUpdateSchema.safeParse({ ...provider, models: Array.from({ length: 11 }, (_, i) => `model-${i}`) }).success).toBe(false);
    expect(adminProviderUpdateSchema.safeParse({ ...provider, baseUrl: "x".repeat(513) }).success).toBe(false);
    for (const apiKey of ["", "short", "secret key", "secret\nkey", "x".repeat(257)]) {
      expect(adminProviderUpdateSchema.safeParse({ ...provider, secretAction: "replace", apiKey }).success).toBe(false);
    }
  });

  it("does not coerce bounded request counts or accept arbitrary provider IDs", () => {
    for (const maxCallsPerDay of [0, 501, 1.5, "8", null]) {
      expect(adminLimitsUpdateSchema.safeParse({ ...limits, maxCallsPerDay }).success).toBe(false);
    }
    for (const maxActiveRuns of [0, 11, 1.5, "1", null]) {
      expect(adminLimitsUpdateSchema.safeParse({ ...limits, maxActiveRuns }).success).toBe(false);
    }
    expect(adminProviderKeySchema.safeParse("custom-provider").success).toBe(false);
    expect(adminLimitsUpdateSchema.safeParse({ ...limits, defaultProvider: "custom-provider" }).success).toBe(false);
    expect(adminLimitsUpdateSchema.safeParse({ ...limits, defaultProvider: null }).success).toBe(true);
    expect(adminLimitsUpdateSchema.safeParse({ ...limits, maxCallsPerDay: 500, maxActiveRuns: 10 }).success).toBe(true);
  });
});
