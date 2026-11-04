import { describe, expect, it } from "vitest";
import { createRealMediaReceiptCipher, loadRealMediaEnvironment, ServerRealMediaRuntime } from "./real-media-runtime";
const workspaceId = "00000000-0000-4000-8000-000000000001";
const key = Buffer.alloc(32, 21).toString("base64"), previous = Buffer.alloc(32, 22).toString("base64");
const configured = { REAL_MEDIA_ENABLED: "true", REAL_MEDIA_RECEIPT_KEY: key,
  DASHSCOPE_MEDIA_API_KEY: "server-only-test-key", REAL_MEDIA_PRICE_VERSION: "operator-20261101",
  DASHSCOPE_MEDIA_PRICE_IMAGE: "0.18", DASHSCOPE_MEDIA_PRICE_VIDEO_SECOND: "0.15", DASHSCOPE_MEDIA_PRICE_TTS_CHARACTER: "0.00008" };
describe("real media configuration and encrypted receipts", () => {
  it("is disabled by default and ignores file-only production permission and secrets", async () => {
    const env = loadRealMediaEnvironment({}, configured);
    expect(env.REAL_MEDIA_RECEIPT_KEY).toBeUndefined();
    expect(env.DASHSCOPE_MEDIA_API_KEY).toBeUndefined();
    const runtime = new ServerRealMediaRuntime(workspaceId, env, false);
    expect(await runtime.configurationFor("image.generate")).toBeNull();
    expect(runtime.receiptCipher).toBeUndefined();
  });
  it("keeps explicit empty process values instead of taking a file secret or switch", () => {
    const env = loadRealMediaEnvironment({ REAL_MEDIA_ENABLED: "false", DASHSCOPE_MEDIA_API_KEY: "" }, configured);
    expect(env.REAL_MEDIA_ENABLED).toBe("false");
    expect(env.DASHSCOPE_MEDIA_API_KEY).toBe("");
  });
  it.each(["TRUE", "1", ""])("rejects invalid production flag %s", value => {
    expect(() => loadRealMediaEnvironment({ REAL_MEDIA_ALLOW_PRODUCTION: value })).toThrow("REAL_MEDIA_ALLOW_PRODUCTION");
  });
  it("does not expose rejected credentials in configuration errors", () => {
    const secret = "test-key with whitespace";
    const error = (() => { try { loadRealMediaEnvironment({ DASHSCOPE_MEDIA_API_KEY: secret }); } catch (e) { return e as Error; } })()!;
    expect(error.message).toContain("DASHSCOPE_MEDIA_API_KEY");
    expect(error.message).not.toContain(secret);
  });
  it("requires an operator price and key, never invents a current rate", async () => {
    const runtime = new ServerRealMediaRuntime(workspaceId, loadRealMediaEnvironment({ ...configured, DASHSCOPE_MEDIA_PRICE_IMAGE: "" }), true);
    expect(await runtime.configurationFor("image.generate")).toBeNull();
    expect(await runtime.configurationFor("audio.music")).toBeNull();
  });
  it("retains a stable database identity but freezes every configuration version", async () => {
    const first = await new ServerRealMediaRuntime(workspaceId, loadRealMediaEnvironment(configured), true).configurationFor("image.generate");
    const second = await new ServerRealMediaRuntime(workspaceId, loadRealMediaEnvironment({ ...configured, DASHSCOPE_MEDIA_PRICE_IMAGE: "0.20" }), true).configurationFor("image.generate");
    expect(first?.id).toBe(second?.id);
    expect(first?.version).not.toBe(second?.version);
    expect(JSON.stringify(first)).not.toContain("server-only-test-key");
  });
  it("disables new submission yet allows original-query credentials after rotation", async () => {
    const before = new ServerRealMediaRuntime(workspaceId, loadRealMediaEnvironment(configured), true);
    const frozen = (await before.configurationFor("image.generate"))!;
    const after = new ServerRealMediaRuntime(workspaceId, loadRealMediaEnvironment({ ...configured, REAL_MEDIA_ENABLED: "false",
      DASHSCOPE_MEDIA_API_KEY: "new-server-only-key", DASHSCOPE_MEDIA_CREDENTIAL_VERSION: "v2",
      DASHSCOPE_MEDIA_PREVIOUS_API_KEY: configured.DASHSCOPE_MEDIA_API_KEY, DASHSCOPE_MEDIA_PREVIOUS_CREDENTIAL_VERSION: "v1" }), false);
    expect((await after.adapterFor(frozen, "query")).providerKey).toBe("dashscope-media");
    await expect(after.adapterFor(frozen, "submit")).rejects.toThrow("REAL_MEDIA_CONFIGURATION_CHANGED");
    expect(JSON.stringify(after)).not.toContain("server-only");
  });
  it("fails closed if a frozen credential version is unavailable", async () => {
    const runtime = new ServerRealMediaRuntime(workspaceId, loadRealMediaEnvironment(configured), true);
    const frozen = (await runtime.configurationFor("image.generate"))!;
    await expect(runtime.adapterFor({ ...frozen, credentialVersion: "unknown" }, "query")).rejects.toThrow("REAL_MEDIA_CREDENTIAL_VERSION_UNAVAILABLE");
  });
  it("only advertises supported fixed-speed neutral preset voices", async () => {
    const catalog = await new ServerRealMediaRuntime(workspaceId, loadRealMediaEnvironment(configured), true).speechCatalog();
    expect(catalog.available).toBe(true);
    expect(catalog.voices.map(v => v.voiceId)).toEqual(["Cherry", "Ethan", "Serena"]);
    expect(catalog.voices.every(v => v.capabilities.speedMin === 1 && v.capabilities.speedMax === 1
      && v.capabilities.emotions.join() === "neutral")).toBe(true);
  });
  it("authenticates receipts, hides signed URLs, and supports a retained old sealing key", () => {
    const old = createRealMediaReceiptCipher({ REAL_MEDIA_RECEIPT_KEY: previous, REAL_MEDIA_RECEIPT_KEY_VERSION: "v1" })!;
    const current = createRealMediaReceiptCipher({ REAL_MEDIA_RECEIPT_KEY: key, REAL_MEDIA_RECEIPT_KEY_VERSION: "v2",
      REAL_MEDIA_PREVIOUS_RECEIPT_KEY: previous, REAL_MEDIA_PREVIOUS_RECEIPT_KEY_VERSION: "v1" })!;
    const value = { outputs: [{ uri: "https://private.example/file?signature=secret" }] };
    const sealed = old.seal(value);
    expect(sealed).not.toContain("signature");
    expect(current.open(sealed)).toEqual(value);
    const tampered = JSON.parse(sealed); tampered.keyVersion = "v2";
    expect(() => current.open(JSON.stringify(tampered))).toThrow("REAL_MEDIA_RECEIPT_UNAVAILABLE");
    expect(() => current.open(sealed.slice(0, -4))).toThrow("REAL_MEDIA_RECEIPT_UNAVAILABLE");
  });
});

describe("real media runtime read-only recovery and exact money configuration",()=>{
  it("gives query recovery no submit capability even when the original frozen configuration was enabled",async()=>{
    const sent:Array<{method:string;headers:Record<string,string>}>=[];
    const transport:import("./real-media-adapters").RealMediaHttpTransport=async request=>{sent.push(request);return {status:200,headers:{},bytes:Buffer.from(JSON.stringify({output:{task_id:"known-task",task_status:"PENDING"}}))};};
    const original=new ServerRealMediaRuntime(workspaceId,loadRealMediaEnvironment(configured),true),frozen=(await original.configurationFor("image.generate"))!;
    const rotated=new ServerRealMediaRuntime(workspaceId,loadRealMediaEnvironment({...configured,REAL_MEDIA_ENABLED:"false",DASHSCOPE_MEDIA_API_KEY:"new-server-test-key",DASHSCOPE_MEDIA_CREDENTIAL_VERSION:"v2",DASHSCOPE_MEDIA_PREVIOUS_API_KEY:configured.DASHSCOPE_MEDIA_API_KEY,DASHSCOPE_MEDIA_PREVIOUS_CREDENTIAL_VERSION:"v1"}),false,transport);
    const adapter=await rotated.adapterFor(frozen,"query");
    await expect(adapter.submit({} as never)).rejects.toThrow("MEDIA_SUBMIT_DISABLED");expect(sent).toEqual([]);
    expect((await adapter.inspect("known-task")).state).toBe("ACTIVE");expect(sent).toHaveLength(1);expect(sent[0]!.method).toBe("GET");expect(sent[0]!.headers.Authorization).toBe("Bearer "+configured.DASHSCOPE_MEDIA_API_KEY);
    await expect(rotated.adapterFor(frozen,"submit")).rejects.toThrow("REAL_MEDIA_CONFIGURATION_CHANGED");
    await expect(rotated.adapterFor({...frozen,queryAllowed:false},"query")).rejects.toThrow("REAL_MEDIA_QUERY_DISABLED");expect(sent).toHaveLength(1);
  });
  it.each(["", " ", "-1", "1e-3", "NaN", "0", "0.000000001", "100000000"])("rejects invalid maximum operation amount %s by field name",value=>{
    expect(()=>loadRealMediaEnvironment({...configured,REAL_MEDIA_MAX_SINGLE_CNY:value})).toThrow("REAL_MEDIA_MAX_SINGLE_CNY");
  });
  it("keeps the smallest supported decimal exactly and rejects blank version namespaces",async()=>{
    const runtime=new ServerRealMediaRuntime(workspaceId,loadRealMediaEnvironment({...configured,DASHSCOPE_MEDIA_PRICE_IMAGE:"0.00000001",REAL_MEDIA_MAX_SINGLE_CNY:"0.00000002"}),true);
    expect(await runtime.configurationFor("image.generate")).toMatchObject({unitPrice:"0.00000001",maximumOperationAmount:"0.00000002"});
    for(const name of ["REAL_MEDIA_RECEIPT_KEY_VERSION","DASHSCOPE_MEDIA_CREDENTIAL_VERSION","REAL_MEDIA_PRICE_VERSION"])expect(()=>loadRealMediaEnvironment({...configured,[name]:""})).toThrow(name);
  });
  it("rejects ambiguous old/current credential and receipt key versions",()=>{
    expect(()=>new ServerRealMediaRuntime(workspaceId,loadRealMediaEnvironment({...configured,DASHSCOPE_MEDIA_PREVIOUS_API_KEY:"old-test-key",DASHSCOPE_MEDIA_PREVIOUS_CREDENTIAL_VERSION:"v1"}),true)).toThrow("DASHSCOPE_MEDIA_PREVIOUS_CREDENTIAL_VERSION");
    expect(()=>createRealMediaReceiptCipher({REAL_MEDIA_RECEIPT_KEY:key,REAL_MEDIA_PREVIOUS_RECEIPT_KEY:previous,REAL_MEDIA_PREVIOUS_RECEIPT_KEY_VERSION:"v1"})).toThrow("REAL_MEDIA_PREVIOUS_RECEIPT_KEY_VERSION");
  });
  it("keeps elevenlabs speech off the music credential and the qwen speech profile", async () => {
    const musicOnly = loadRealMediaEnvironment({ ...configured, ELEVENLABS_MEDIA_API_KEY: "music-only-test-key", ELEVENLABS_MEDIA_PRICE_MUSIC_SECOND: "0.05" });
    const musicRuntime = new ServerRealMediaRuntime(workspaceId, musicOnly, true);
    expect(await musicRuntime.elevenLabsTtsConfiguration()).toBeNull();
    expect(await musicRuntime.configurationFor("audio.tts")).toMatchObject({ providerKey: "dashscope-media", model: "qwen3-tts-flash" });
    expect(await musicRuntime.configurationFor("audio.music")).toMatchObject({ providerKey: "elevenlabs-media", model: "music_v2", unitPrice: "0.05" });
    expect(() => loadRealMediaEnvironment({ ELEVENLABS_TTS_OUTPUT_FORMAT: "mp3_44100_128" })).toThrow("ELEVENLABS_TTS_OUTPUT_FORMAT");
    const speech = loadRealMediaEnvironment({ ...configured, ELEVENLABS_TTS_API_KEY: "speech-only-test-key", ELEVENLABS_TTS_PRICE_CHARACTER: "0.00012", ELEVENLABS_TTS_OUTPUT_FORMAT: "pcm_44100" });
    const runtime = new ServerRealMediaRuntime(workspaceId, speech, true);
    const tts = await runtime.elevenLabsTtsConfiguration();
    expect(tts).toMatchObject({ providerKey: "elevenlabs-tts", model: "eleven_v4", capability: "audio.tts", currency: "USD", unitType: "character", unitPrice: "0.00012", credentialRef: "env:elevenlabs-tts", parameters: { outputFormat: "pcm_44100", languageCode: "zh" } });
    expect(await runtime.configurationFor("audio.tts")).toMatchObject({ providerKey: "dashscope-media", model: "qwen3-tts-flash" });
    expect(JSON.stringify(tts)).not.toContain("speech-only-test-key");
    const sent: Array<{ url: string; body?: string }> = [];
    const transport: import("./real-media-adapters").RealMediaHttpTransport = async (request) => {
      sent.push(request);
      return { status: 500, headers: {}, bytes: Buffer.from("{}") };
    };
    const calling = new ServerRealMediaRuntime(workspaceId, speech, true, transport);
    const frozen = (await calling.elevenLabsTtsConfiguration())!;
    const adapter = await calling.adapterFor(frozen, "submit");
    expect(adapter.providerKey).toBe("elevenlabs-tts");
    const query = await calling.adapterFor({ ...frozen, enabled: true }, "query");
    await expect(query.submit({} as never)).rejects.toThrow("MEDIA_SUBMIT_DISABLED");
    expect((await query.inspect("dlg_frozen_1")).state).toBe("UNKNOWN");
    expect(sent).toEqual([]);
  });
  it("does not enable production permission or inject keys from an environment file",()=>{
    const env=loadRealMediaEnvironment({...configured,REAL_MEDIA_ALLOW_PRODUCTION:"false"},{REAL_MEDIA_ALLOW_PRODUCTION:"true",REAL_MEDIA_RECEIPT_KEY:previous,DASHSCOPE_MEDIA_API_KEY:"file-only-secret"});
    expect(env.REAL_MEDIA_ALLOW_PRODUCTION).toBe("false");expect(env.REAL_MEDIA_RECEIPT_KEY).toBe(key);expect(env.DASHSCOPE_MEDIA_API_KEY).toBe(configured.DASHSCOPE_MEDIA_API_KEY);
    expect(loadRealMediaEnvironment({}, {REAL_MEDIA_ALLOW_PRODUCTION:"true"}).REAL_MEDIA_ALLOW_PRODUCTION).toBeUndefined();
  });
});

describe("explicit openai sunburst image configuration", () => {
  const sunburst = { ...configured, REAL_MEDIA_IMAGE_PROVIDER: "openai-media", OPENAI_MEDIA_API_KEY: "openai-media-test-key",
    OPENAI_MEDIA_PRICE_IMAGE: "0.04", OPENAI_BASE_URL: "https://image.example.test/" };
  it("keeps DashScope image when sunburst credentials exist but the provider is not selected", async () => {
    const env = loadRealMediaEnvironment({ ...configured, OPENAI_MEDIA_API_KEY: sunburst.OPENAI_MEDIA_API_KEY,
      OPENAI_MEDIA_PRICE_IMAGE: "0.04", OPENAI_BASE_URL: "https://image.example.test" });
    const image = await new ServerRealMediaRuntime(workspaceId, env, true).configurationFor("image.generate");
    expect(image).toMatchObject({ providerKey: "dashscope-media", model: "qwen-image-3.0", currency: "CNY" });
  });
  it("pins sunburst only when explicitly selected and does not fall back when that config is incomplete", async () => {
    const ready = new ServerRealMediaRuntime(workspaceId, loadRealMediaEnvironment(sunburst), true);
    const image = await ready.configurationFor("image.generate");
    expect(image).toMatchObject({ providerKey: "openai-media", model: "gpt-image-2.5-sunburst", region: "image.example.test",
      credentialRef: "env:openai-media", currency: "USD", unitType: "image",
      parameters: { baseUrl: "https://image.example.test", quality: "max", size: "1024x1536" } });
    expect(JSON.stringify(image)).not.toContain("openai-media-test-key");
    expect(await ready.configurationFor("video.generate")).toMatchObject({ providerKey: "dashscope-media", model: "wan2.6-i2v-flash" });
    const moved = await new ServerRealMediaRuntime(workspaceId, loadRealMediaEnvironment({ ...sunburst, OPENAI_API_BASE: "https://image.example.test" }), true).configurationFor("image.generate");
    expect(moved?.id).toBe(image?.id);
    expect(await new ServerRealMediaRuntime(workspaceId, loadRealMediaEnvironment({ ...sunburst, OPENAI_BASE_URL: undefined, OPENAI_API_BASE: undefined }), true).configurationFor("image.generate")).toBeNull();
    expect(await new ServerRealMediaRuntime(workspaceId, loadRealMediaEnvironment({ ...sunburst, OPENAI_MEDIA_API_KEY: undefined }), true).configurationFor("image.generate")).toBeNull();
    expect(await new ServerRealMediaRuntime(workspaceId, loadRealMediaEnvironment({ ...sunburst, OPENAI_MEDIA_PRICE_IMAGE: undefined }), true).configurationFor("image.generate")).toBeNull();
    expect(await new ServerRealMediaRuntime(workspaceId, loadRealMediaEnvironment({ ...sunburst, OPENAI_BASE_URL: undefined }), true).configurationFor("video.generate"))
      .toMatchObject({ model: "wan2.6-i2v-flash" });
  });
  it("rejects other image providers and conflicting bases by field name", () => {
    for (const provider of ["gpt-image-2.5-flare", "qwen-image-3.0", "dall-e-3", "dall-e"]) {
      expect(() => loadRealMediaEnvironment({ ...sunburst, REAL_MEDIA_IMAGE_PROVIDER: provider })).toThrow("REAL_MEDIA_IMAGE_PROVIDER");
    }
    expect(() => loadRealMediaEnvironment({ ...sunburst, OPENAI_API_BASE: "https://other.example.test" })).toThrow("OPENAI_BASE_URL");
    expect(() => loadRealMediaEnvironment({ ...sunburst, OPENAI_BASE_URL: "http://image.example.test" })).toThrow("OPENAI_BASE_URL");
    expect(() => loadRealMediaEnvironment({ ...sunburst, OPENAI_BASE_URL: "" })).toThrow("OPENAI_BASE_URL");
  });
  it("ignores file-only image provider, base URL and media key", () => {
    const env = loadRealMediaEnvironment(configured, { REAL_MEDIA_IMAGE_PROVIDER: "openai-media", OPENAI_BASE_URL: "https://file.example.test",
      OPENAI_API_BASE: "https://file.example.test", OPENAI_MEDIA_API_KEY: "file-only-openai-media-key" });
    expect(env.REAL_MEDIA_IMAGE_PROVIDER).toBeUndefined();
    expect(env.OPENAI_BASE_URL).toBeUndefined();
    expect(env.OPENAI_MEDIA_API_KEY).toBeUndefined();
  });
  it("gives sunburst query recovery no submit and no second generation", async () => {
    const sent: string[] = [];
    const transport: import("./real-media-adapters").RealMediaHttpTransport = async (request) => {
      sent.push(request.method + " " + request.url);
      return { status: 200, headers: { "x-request-id": "req_1" }, bytes: Buffer.from(JSON.stringify({ data: [{ b64_json: "aaaa" }] })) };
    };
    const runtime = new ServerRealMediaRuntime(workspaceId, loadRealMediaEnvironment(sunburst), true, transport);
    const frozen = (await runtime.configurationFor("image.generate"))!;
    const adapter = await runtime.adapterFor(frozen, "query");
    await expect(adapter.submit({} as never)).rejects.toThrow("MEDIA_SUBMIT_DISABLED");
    expect((await adapter.inspect("req_1")).state).toBe("UNKNOWN");
    expect(sent).toEqual([]);
  });
});

describe("independent minimax speech configuration", () => {
  const minimax = {
    ...configured, MINIMAX_API_KEY: "minimax-server-test-key", MINIMAX_TTS_PRICE_CHARACTER: "0.0002",
    MINIMAX_TTS_MODEL: "speech-2.8-hd", MINIMAX_TTS_BASE_URL: "https://api.minimaxi.com",
    MINIMAX_TTS_OUTPUT_FORMAT: "wav", MINIMAX_TTS_SAMPLE_RATE: "44100",
  };
  it("does not borrow elevenlabs, music, or qwen speech settings", async () => {
    const musicOnly = loadRealMediaEnvironment({
      ...configured, ELEVENLABS_MEDIA_API_KEY: "music-only-test-key", ELEVENLABS_MEDIA_PRICE_MUSIC_SECOND: "0.05",
      ELEVENLABS_TTS_API_KEY: "speech-only-test-key", ELEVENLABS_TTS_PRICE_CHARACTER: "0.00012",
    });
    const musicRuntime = new ServerRealMediaRuntime(workspaceId, musicOnly, true);
    expect(await musicRuntime.minimaxTtsConfiguration()).toBeNull();
    expect(await musicRuntime.configurationFor("audio.tts")).toMatchObject({ providerKey: "dashscope-media", model: "qwen3-tts-flash" });
    expect(await musicRuntime.elevenLabsTtsConfiguration()).toMatchObject({ providerKey: "elevenlabs-tts", model: "eleven_v4" });
    const runtime = new ServerRealMediaRuntime(workspaceId, loadRealMediaEnvironment(minimax), true);
    const speech = await runtime.minimaxTtsConfiguration();
    expect(speech).toMatchObject({
      providerKey: "minimax-tts", model: "speech-2.8-hd", capability: "audio.tts", currency: "CNY", unitType: "character",
      unitPrice: "0.0002", credentialRef: "env:minimax-tts", region: "api.minimaxi.com",
      parameters: { outputFormat: "wav", sampleRate: 44100, baseUrl: "https://api.minimaxi.com" },
    });
    expect(await runtime.configurationFor("audio.tts")).toMatchObject({ providerKey: "dashscope-media", model: "qwen3-tts-flash" });
    expect(await runtime.elevenLabsTtsConfiguration()).toBeNull();
    expect(JSON.stringify(speech)).not.toContain("minimax-server-test-key");
    expect(loadRealMediaEnvironment({}, { MINIMAX_API_KEY: "file-only-minimax-key" }).MINIMAX_API_KEY).toBeUndefined();
  });
  it("rejects a substituted model, format, rate, or foreign host", () => {
    expect(() => loadRealMediaEnvironment({ MINIMAX_TTS_MODEL: "speech-02-hd" })).toThrow("MINIMAX_TTS_MODEL");
    expect(() => loadRealMediaEnvironment({ MINIMAX_TTS_OUTPUT_FORMAT: "mp3" })).toThrow("MINIMAX_TTS_OUTPUT_FORMAT");
    expect(() => loadRealMediaEnvironment({ MINIMAX_TTS_SAMPLE_RATE: "32000" })).toThrow("MINIMAX_TTS_SAMPLE_RATE");
    expect(() => loadRealMediaEnvironment({ MINIMAX_TTS_BASE_URL: "https://api.elevenlabs.io" })).toThrow("MINIMAX_TTS_BASE_URL");
    expect(() => loadRealMediaEnvironment({ MINIMAX_TTS_BASE_URL: "http://api.minimaxi.com" })).toThrow("MINIMAX_TTS_BASE_URL");
    expect(() => new ServerRealMediaRuntime(workspaceId, loadRealMediaEnvironment({
      ...minimax, MINIMAX_PREVIOUS_API_KEY: "old-minimax-test-key", MINIMAX_TTS_PREVIOUS_CREDENTIAL_VERSION: "v1",
    }), true)).toThrow("MINIMAX_TTS_PREVIOUS_CREDENTIAL_VERSION");
  });
  it("query recovery cannot submit and does not call the network", async () => {
    const sent: string[] = [];
    const transport: import("./real-media-adapters").RealMediaHttpTransport = async (request) => {
      sent.push(request.url);
      return { status: 500, headers: {}, bytes: Buffer.from("{}") };
    };
    const runtime = new ServerRealMediaRuntime(workspaceId, loadRealMediaEnvironment(minimax), true, transport);
    const frozen = (await runtime.minimaxTtsConfiguration())!;
    const adapter = await runtime.adapterFor(frozen, "submit");
    expect(adapter.providerKey).toBe("minimax-tts");
    const query = await runtime.adapterFor(frozen, "query");
    await expect(query.submit({} as never)).rejects.toThrow("MEDIA_SUBMIT_DISABLED");
    expect((await query.inspect("mm_frozen_1")).state).toBe("UNKNOWN");
    expect(sent).toEqual([]);
    expect(await new ServerRealMediaRuntime(workspaceId, loadRealMediaEnvironment({ ...minimax, MINIMAX_TTS_PRICE_CHARACTER: undefined }), true).minimaxTtsConfiguration()).toBeNull();
    expect(await new ServerRealMediaRuntime(workspaceId, loadRealMediaEnvironment({ ...minimax, MINIMAX_API_KEY: undefined }), true).configurationFor("audio.tts"))
      .toMatchObject({ providerKey: "dashscope-media" });
  });
});
