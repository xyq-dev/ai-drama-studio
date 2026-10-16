import { describe, expect, it } from "vitest";
import {
  adminLimitsUpdateSchema, adminProviderKeySchema, adminProviderUpdateSchema, claudeSetupState, workspaceUpdateOf, type AdminModelsView,
} from "./admin-models";
import { anthropicKeyProblem, anthropicWorkspaceIdValid } from "./title-writing";

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
    // Active and ready with the old key, a new key saved: not "ready" until the restart applies it.
    expect(claudeSetupState(view({ pendingRestart: true })).state).toBe("pending_restart");
    expect(claudeSetupState(view({ pendingRestart: true, activationDeferred: true })).state).toBe("activation_deferred");
    expect(claudeSetupState(view({ titleWriting: { enabled: false, productionBlocked: false, operatorConfigured: false, siteOperator: true } })).state).toBe("feature_off");
    expect(claudeSetupState(view({ titleWriting: { enabled: true, productionBlocked: false, operatorConfigured: false, siteOperator: false } })).state).toBe("operator_missing");
    expect(claudeSetupState(view({ storage: null })).state).toBe("storage_unknown");
    expect(claudeSetupState(view({ storage: { titleWriting: true, claude: false, candidates: false } })))
      .toEqual({ state: "migration_missing", migrations: ["20261016000100_writing_provider_anthropic", "20261016000200_writing_candidate"] });
    expect(claudeSetupState(view()).state).toBe("ready");
  });

  it("accepts the Claude Console key kinds: legacy sk-ant-api, personal sk-ant-usr and service account sk-ant-svc (fake test keys)", () => {
    for (const key of ["sk-ant-api03-abcdefghijklmnopqrstuvwxyz", "sk-ant-api-abcdefghijklmnop", "sk-ant-usr-fake-personal-key-for-tests-only",
      "sk-ant-usr01-fake_personal_key_for_tests", "sk-ant-svc-fake-service-key-for-tests-only", `sk-ant-usr-${"a".repeat(245)}`]) {
      expect(anthropicKeyProblem(key)).toBeNull();
    }
  });

  it("names a known credential of another kind separately from an unsupported format, and never accepts any sk-ant- value", () => {
    for (const credential of ["sk-ant-oat01-abcdefghijklmnopqrstuvwxyz", "sk-ant-oat-abcdefghijklmnop", "sk-ant-ort01-abcdefghijklmnopqrstuvwxyz",
      "sk-ant-admin01-abcdefghijklmnopqrstuvwxyz", "sk-ant-sid01-abcdefghijklmnop", "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0.c2ln"]) {
      expect(anthropicKeyProblem(credential)).toBe("not_api_credential");
    }
    for (const value of ["", "sk-proj-abcdefghijklmnopqrstuvwxyz", "sk-ant-abcdefghijklmnopqrstuvwxyz", "sk-ant-xyz-abcdefghijklmnop",
      "sk-ant-api03-short", "sk-ant-usr-", "sk-ant-usr-abc def ghi jkl", "sk-ant-usr-abcdefgh\r\nX-Evil: 1", " sk-ant-usr-abcdefghijkl",
      "sk-ant-usr-abcdefghijkl ", "sk-ant-usr-abcdefgh.ijkl", "sk-ant-usr-密钥密钥密钥密钥", "Bearer sk-ant-usr-abcdefghijkl",
      `sk-ant-usr-${"a".repeat(246)}`]) {
      expect(anthropicKeyProblem(value), value).toBe("unsupported_format");
    }
  });

  it("a workspace id has the Console shape; a new key never keeps the previous key's workspace", () => {
    expect(anthropicWorkspaceIdValid("wrkspc_01JwQvzr7rXLA5AGx3HKfFUJ")).toBe(true);
    for (const value of ["", "default", "wrkspc_", "wrkspc_ab", "wrkspc_01Jw Qvzr", "wrkspc_01Jw\r\nX: 1", "sk-ant-usr-abcdefghijkl"]) {
      expect(anthropicWorkspaceIdValid(value)).toBe(false);
    }
    const base = { expectedRevision: 0, models: [] };
    const parse = (body: Record<string, unknown>) => adminProviderUpdateSchema.safeParse({ ...base, ...body });
    expect(parse({ secretAction: "keep", workspaceAction: "keep" }).success).toBe(true);
    expect(parse({ secretAction: "replace", apiKey: "sk-ant-usr-abcdefghijkl", workspaceAction: "keep" }).success).toBe(false);
    expect(parse({ secretAction: "clear", workspaceAction: "keep" }).success).toBe(false);
    expect(parse({ secretAction: "keep", workspaceAction: "replace" }).success).toBe(false);
    expect(parse({ secretAction: "keep", workspaceId: "wrkspc_01JwQvzr7rXLA5AGx3HKfFUJ" }).success).toBe(false);
    const update = (body: Record<string, unknown>) => {
      const parsed = parse(body);
      if (!parsed.success) throw new Error("invalid");
      return workspaceUpdateOf(parsed.data);
    };
    expect(update({ secretAction: "keep" })).toBe("keep");
    expect(update({ secretAction: "replace", apiKey: "sk-ant-usr-abcdefghijkl" })).toBeNull();
    expect(update({ secretAction: "clear" })).toBeNull();
    expect(update({ secretAction: "keep", workspaceAction: "clear" })).toBeNull();
    expect(update({ secretAction: "replace", apiKey: "sk-ant-usr-abcdefghijkl", workspaceAction: "replace", workspaceId: "wrkspc_01JwQvzr7rXLA5AGx3HKfFUJ" }))
      .toBe("wrkspc_01JwQvzr7rXLA5AGx3HKfFUJ");
  });
});
