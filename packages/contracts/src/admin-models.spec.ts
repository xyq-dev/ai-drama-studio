import { describe, expect, it } from "vitest";
import { adminLimitsUpdateSchema, adminProviderKeySchema, adminProviderUpdateSchema, claudeSetupState, type AdminModelsView } from "./admin-models";
import { anthropicKeyProblem } from "./title-writing";

const provider = { expectedRevision: 0, models: ["test-model:2026"], secretAction: "keep" };
const limits = { expectedRevision: 0, defaultProvider: "anthropic", maxCallsPerDay: 8, maxActiveRuns: 1 };

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
    // Retired providers have no console entry and can never become the default again.
    for (const retired of ["qwen", "deepseek"]) {
      expect(adminProviderKeySchema.safeParse(retired).success).toBe(false);
      expect(adminLimitsUpdateSchema.safeParse({ ...limits, defaultProvider: retired }).success).toBe(false);
    }
    expect(adminProviderKeySchema.options).toEqual(["openai", "anthropic"]);
    expect(adminLimitsUpdateSchema.safeParse({ ...limits, defaultProvider: "custom-provider" }).success).toBe(false);
    expect(adminLimitsUpdateSchema.safeParse({ ...limits, defaultProvider: null }).success).toBe(true);
    expect(adminLimitsUpdateSchema.safeParse({ ...limits, maxCallsPerDay: 500, maxActiveRuns: 10 }).success).toBe(true);
  });
});

describe("Claude setup state", () => {
  const provider = (keyConfigured: boolean, ready: boolean) => ({ providerKey: "anthropic" as const, label: "Claude", models: ["claude-opus-5-5"],
    baseUrl: "https://api.anthropic.com/v1/messages", keyConfigured, ready, missing: ready ? [] : ["ANTHROPIC_API_KEY"] });
  const settings = (keyConfigured: boolean, ready: boolean) => ({ defaultProvider: null, maxCallsPerDay: 30, maxActiveRuns: 1,
    providers: [provider(keyConfigured, ready)] });
  const view = (patch: Partial<AdminModelsView> = {}): AdminModelsView => ({
    savedRevision: 1, activeRevision: 1, pendingRestart: false, activationDeferred: false, source: "managed",
    titleWriting: { enabled: true, productionBlocked: false, operatorConfigured: false, siteOperator: true },
    saved: settings(true, true), active: settings(true, true), audit: [], validation: "local_only",
    storage: { titleWriting: true, claude: true, candidates: true }, ...patch,
  });

  it("names exactly one state, in the order it must be resolved; saved is never ready", () => {
    expect(claudeSetupState(view({ saved: settings(false, false), active: settings(false, false) })).state).toBe("key_missing");
    expect(claudeSetupState(view({ pendingRestart: true, active: settings(false, false) })).state).toBe("pending_restart");
    expect(claudeSetupState(view({ pendingRestart: true, activationDeferred: true, active: settings(false, false) })).state).toBe("activation_deferred");
    expect(claudeSetupState(view({ active: settings(true, false) })).state).toBe("incomplete");
    expect(claudeSetupState(view({ titleWriting: { enabled: false, productionBlocked: false, operatorConfigured: false, siteOperator: true } })).state).toBe("feature_off");
    expect(claudeSetupState(view({ titleWriting: { enabled: true, productionBlocked: false, operatorConfigured: false, siteOperator: false } })).state).toBe("operator_missing");
    expect(claudeSetupState(view({ storage: null })).state).toBe("storage_unknown");
    expect(claudeSetupState(view({ storage: { titleWriting: true, claude: false, candidates: false } })))
      .toEqual({ state: "migration_missing", migrations: ["20261016000100_writing_provider_anthropic", "20261016000200_writing_candidate"] });
    expect(claudeSetupState(view()).state).toBe("ready");
  });

  it("accepts only Anthropic Console API keys", () => {
    expect(anthropicKeyProblem("sk-ant-api03-abcdefghijklmnopqrstuvwxyz")).toBeNull();
    expect(anthropicKeyProblem("sk-ant-oat01-abcdefghijklmnopqrstuvwxyz")).toBe("not_api_key");
    expect(anthropicKeyProblem("sk-ant-admin01-abcdefghijklmnopqrstuvwxyz")).toBe("not_api_key");
    expect(anthropicKeyProblem("sk-proj-abcdefghijklmnopqrstuvwxyz")).toBe("not_anthropic_key");
    expect(anthropicKeyProblem("sk-ant-api03-short")).toBe("not_api_key");
  });
});
