import { describe, expect, it } from "vitest";
import { loadApiEnv } from "./env";

const valid = {
  DATABASE_URL: "postgresql://ai_drama:super-secret-password@127.0.0.1:55432/ai_drama",
  REDIS_URL: "redis://127.0.0.1:56379",
  S3_ENDPOINT: "http://127.0.0.1:59000",
  S3_REGION: "us-east-1",
  S3_BUCKET: "ai-drama-dev",
  S3_ACCESS_KEY_ID: "ai-drama-dev",
  S3_SECRET_ACCESS_KEY: "another-secret-value",
  APP_WORKSPACE_ID: "11111111-1111-4111-8111-111111111111",
};

describe("loadApiEnv", () => {
  it("accepts production title authorization only from the process environment", () => {
    expect(loadApiEnv(valid, { TITLE_WRITING_ALLOW_PRODUCTION: "true" }).TITLE_WRITING_ALLOW_PRODUCTION).toBe(false);
    expect(loadApiEnv({ ...valid, TITLE_WRITING_ALLOW_PRODUCTION: "false" },
      { TITLE_WRITING_ALLOW_PRODUCTION: "true" }).TITLE_WRITING_ALLOW_PRODUCTION).toBe(false);
    expect(loadApiEnv({ ...valid, TITLE_WRITING_ALLOW_PRODUCTION: "true" },
      { TITLE_WRITING_ALLOW_PRODUCTION: "false" }).TITLE_WRITING_ALLOW_PRODUCTION).toBe(true);
    expect(loadApiEnv(valid, { TITLE_WRITING_ALLOW_PRODUCTION: "yes" }).TITLE_WRITING_ALLOW_PRODUCTION).toBe(false);
  });

  it.each(["", "yes", "TRUE", "1"])("rejects invalid process production authorization: %j", (value) => {
    expect(() => loadApiEnv({ ...valid, TITLE_WRITING_ALLOW_PRODUCTION: value }))
      .toThrow(/TITLE_WRITING_ALLOW_PRODUCTION/);
  });

  it("uses a read-only production-state root with process values taking precedence", () => {
    expect(loadApiEnv(valid).PRODUCTION_STATE_ROOT).toBe("/workspace/drama-studio/projects");
    expect(loadApiEnv(valid, { PRODUCTION_STATE_ROOT: "/tmp/file-states" }).PRODUCTION_STATE_ROOT).toBe("/tmp/file-states");
    expect(loadApiEnv({ ...valid, PRODUCTION_STATE_ROOT: "/tmp/process-states" },
      { PRODUCTION_STATE_ROOT: "/tmp/file-states" }).PRODUCTION_STATE_ROOT).toBe("/tmp/process-states");
  });

  it("reads the script breakdown switch as a strict boolean that defaults off", () => {
    expect(loadApiEnv(valid).SCRIPT_BREAKDOWN_ENABLED).toBe(false);
    expect(loadApiEnv({ ...valid, SCRIPT_BREAKDOWN_ENABLED: "true" }).SCRIPT_BREAKDOWN_ENABLED).toBe(true);
    expect(loadApiEnv({ ...valid, SCRIPT_BREAKDOWN_ENABLED: "false" }).SCRIPT_BREAKDOWN_ENABLED).toBe(false);
    expect(loadApiEnv(valid, { SCRIPT_BREAKDOWN_ENABLED: "true" }).SCRIPT_BREAKDOWN_ENABLED).toBe(true);
  });

  it.each(["", "yes", "TRUE", "1"])("rejects an invalid script breakdown switch: %j", (value) => {
    expect(() => loadApiEnv({ ...valid, SCRIPT_BREAKDOWN_ENABLED: value })).toThrow(/SCRIPT_BREAKDOWN_ENABLED/);
  });

  it("rejects missing required fields by name", () => {
    expect(() => loadApiEnv({})).toThrow(/DATABASE_URL/);
  });

  it("does not include secret values in validation errors", () => {
    try {
      loadApiEnv({ ...valid, API_PORT: "nope" });
      throw new Error("expected validation to fail");
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      expect(text).toContain("API_PORT");
      expect(text).not.toContain("super-secret-password");
      expect(text).not.toContain("another-secret-value");
    }
  });

  it("prefers process values and ignores unrelated file secrets", () => {
    const env = loadApiEnv(
      { ...valid, API_PORT: "3101" },
      { DATABASE_URL: "postgresql://file-user:file-secret@127.0.0.1:55432/ai_drama", UNUSED_TOKEN: "token" },
    );
    expect(env.API_PORT).toBe(3101);
    expect(env.M3_MOCK_SUBTITLE_MUSIC_ENABLED).toBe(false);
    expect(env.M3_MOCK_AV_ENABLED).toBe(false);
    expect(env.M4_MOCK_SAMPLE_VIDEO_ENABLED).toBe(false);
    expect(env.M3_MOCK_IMAGE_ENABLED).toBe(false);
    expect(env).not.toHaveProperty("QWEN_WEB_WRITING_ENABLED");
    expect(env.DATABASE_URL).toContain("super-secret-password");
    expect(env.S3_FORCE_PATH_STYLE).toBe(true);
  });

  it("reads the Claude key and model allowlist only from the process environment", () => {
    const fromFile = loadApiEnv(valid, { ANTHROPIC_API_KEY: "sk-ant-file-only-secret", TITLE_WRITING_ANTHROPIC_MODELS: "claude-opus-5-5" });
    expect(fromFile.ANTHROPIC_API_KEY).toBeUndefined();
    expect(fromFile.TITLE_WRITING_ANTHROPIC_MODELS).toBeUndefined();
    const fromProcess = loadApiEnv({ ...valid, ANTHROPIC_API_KEY: "sk-ant-process-secret", TITLE_WRITING_ANTHROPIC_MODELS: "claude-opus-5-5" });
    expect(fromProcess.ANTHROPIC_API_KEY).toBe("sk-ant-process-secret");
    expect(fromProcess.TITLE_WRITING_ANTHROPIC_MODELS).toBe("claude-opus-5-5");
    // The optional workspace id follows the same rule.
    expect(loadApiEnv(valid, { ANTHROPIC_WORKSPACE_ID: "wrkspc_01JwQvzr7rXLA5AGx3HKfFUJ" }).ANTHROPIC_WORKSPACE_ID).toBeUndefined();
    expect(loadApiEnv({ ...valid, ANTHROPIC_WORKSPACE_ID: "wrkspc_01JwQvzr7rXLA5AGx3HKfFUJ" }).ANTHROPIC_WORKSPACE_ID).toBe("wrkspc_01JwQvzr7rXLA5AGx3HKfFUJ");
  });

  it("does not read the retired Qwen and DeepSeek variables at all, from the process or a file", () => {
    const retired = {
      DASHSCOPE_API_KEY: "sk-process-secret", BAILIAN_BASE_URL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      QWEN_WEB_MODEL: "qwen-model", QWEN_WEB_WRITING_ENABLED: "true", QWEN_WEB_OPERATOR_TOKEN: "operator-token-0123456789",
      TITLE_WRITING_QWEN_MODELS: "q-1", DEEPSEEK_API_KEY: "sk-deepseek-secret", TITLE_WRITING_DEEPSEEK_MODELS: "d-1",
    };
    for (const env of [loadApiEnv({ ...valid, ...retired }), loadApiEnv(valid, retired)]) {
      for (const name of Object.keys(retired)) expect(env).not.toHaveProperty(name);
    }
  });

  it("keeps an API with a retired default provider starting, without any default, and names the retired one", () => {
    const env = loadApiEnv({ ...valid, TITLE_WRITING_DEFAULT_PROVIDER: "qwen" });
    expect(env.TITLE_WRITING_DEFAULT_PROVIDER).toBeUndefined();
    expect(env.TITLE_WRITING_RETIRED_DEFAULT_PROVIDER).toBe("qwen");
    // DeepSeek is active again: it may be named as the default, but its key still comes only from the console.
    const deepseek = loadApiEnv({ ...valid, TITLE_WRITING_DEFAULT_PROVIDER: "deepseek", DEEPSEEK_API_KEY: "fake-deepseek-env-key-0123456789" });
    expect(deepseek.TITLE_WRITING_DEFAULT_PROVIDER).toBe("deepseek");
    expect(deepseek.TITLE_WRITING_RETIRED_DEFAULT_PROVIDER).toBeUndefined();
    expect(deepseek).not.toHaveProperty("DEEPSEEK_API_KEY");
    expect(loadApiEnv({ ...valid, TITLE_WRITING_DEFAULT_PROVIDER: "anthropic" }).TITLE_WRITING_DEFAULT_PROVIDER).toBe("anthropic");
    expect(() => loadApiEnv({ ...valid, TITLE_WRITING_DEFAULT_PROVIDER: "gemini" })).toThrow("TITLE_WRITING_DEFAULT_PROVIDER");
  });
});

describe("paid production permissions are process-only",()=>{
  it("does not enable title, planning or real media production with a release env file",()=>{
    const env=loadApiEnv({...valid,NODE_ENV:"production"},{TITLE_WRITING_ALLOW_PRODUCTION:"true",VIMAX_ALLOW_PRODUCTION:"true",REAL_MEDIA_ALLOW_PRODUCTION:"true",DASHSCOPE_MEDIA_API_KEY:"file-only-secret",REAL_MEDIA_RECEIPT_KEY:Buffer.alloc(32,7).toString("base64")});
    expect(env.TITLE_WRITING_ALLOW_PRODUCTION).toBe(false);expect(env.VIMAX_ALLOW_PRODUCTION).toBe(false);expect(env.REAL_MEDIA_ENV?.REAL_MEDIA_ALLOW_PRODUCTION).toBeUndefined();expect(env.REAL_MEDIA_ENV?.DASHSCOPE_MEDIA_API_KEY).toBeUndefined();expect(env.REAL_MEDIA_ENV?.REAL_MEDIA_RECEIPT_KEY).toBeUndefined();
  });
  it("reports invalid real media amounts and versions by field names without echoing credentials",()=>{
    try{loadApiEnv({...valid,DASHSCOPE_MEDIA_API_KEY:"synthetic-keep-private",REAL_MEDIA_MAX_SINGLE_CNY:"1e9",DASHSCOPE_MEDIA_CREDENTIAL_VERSION:""});throw new Error("Expected refusal");}
    catch(e){const message=String(e);expect(message).toContain("REAL_MEDIA_MAX_SINGLE_CNY");expect(message).toContain("DASHSCOPE_MEDIA_CREDENTIAL_VERSION");expect(message).not.toContain("synthetic-keep-private");}
  });
});
