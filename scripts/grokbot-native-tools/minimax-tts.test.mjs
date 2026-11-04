import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runCli } from "./cli.mjs";
import {
  authorizeQuote, buildSpeechPlan, buildT2aRequest, createFetchTransport, estimateSpokenAmount, generateSpeech,
  mockT2aResponse, quoteSpeech, resolveMiniMaxApiKey, resolveMiniMaxSettings, resolveMiniMaxUnitPrice, resumeSpeech,
} from "./minimax-tts.mjs";
import { approveScene, approveScript, createProject, emptyStore, saveScript, setCharacters, setStoryboard } from "./store.mjs";

globalThis.fetch = async () => {
  throw new Error("LIVE_MINIMAX_CALL_FORBIDDEN");
};

let passed = 0;
let failed = 0;
const here = dirname(fileURLToPath(import.meta.url));
const scriptText = readFileSync(join(here, "fixtures/moban-che-anhao/script.txt"), "utf8");
const SPOKEN = [
  "师傅，末班车……还会开吗？",
  "暗号对了，就开。",
  "雨声里藏着站名。",
  "那你上车。说错了，你只能等天亮。",
];

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    process.stdout.write(`ok - ${name}\n`);
  } catch (error) {
    failed += 1;
    process.stdout.write(`not ok - ${name}: ${error instanceof Error ? error.stack : error}\n`);
  }
}

function prepared() {
  const store = emptyStore();
  const project = createProject(store, { title: "末班车暗号", premise: "暴雨夜", genre: "悬疑", audience: "年轻观众" });
  saveScript(store, { projectId: project.id, text: scriptText, title: "剧本修订 1" });
  approveScript(store, { projectId: project.id, approvedBy: "user:test" });
  setCharacters(store, { projectId: project.id, characters: JSON.parse(readFileSync(join(here, "fixtures/moban-che-anhao/characters.json"), "utf8")) });
  setStoryboard(store, { projectId: project.id, scene: JSON.parse(readFileSync(join(here, "fixtures/moban-che-anhao/scene.json"), "utf8")) });
  approveScene(store, { projectId: project.id, approvedBy: "user:test" });
  const now = Date.parse("2026-11-04T00:00:00.000Z");
  const plan = buildSpeechPlan(project, { voiceId: "female-shaonv" });
  const quote = quoteSpeech(project, { unitPrice: "0.0002", maximumAmount: "10", voiceId: "female-shaonv", now });
  const authorization = authorizeQuote(project, { quoteId: quote.quoteId, authorizedBy: "user:test", now });
  return { store, project, plan, quote, authorization, now };
}

await test("spoken text stays exact and the request is one domestic t2a_v2 call", async () => {
  const { project, plan } = prepared();
  assert(plan.model === "speech-2.8-hd" && plan.provider === "minimax-tts", "provider");
  assert(plan.fallbackProvider === null, "fallback");
  assert(plan.text === SPOKEN.join("\n"), "lines rewritten");
  assert(!plan.text.includes("背包客") && !plan.text.includes("暴雨夜"), "stage directions leaked");
  const request = buildT2aRequest(plan);
  const body = JSON.parse(request.body);
  assert(request.url === "https://api.minimaxi.com/v1/t2a_v2", request.url);
  assert(!request.url.includes("elevenlabs") && !request.url.includes("dashscope"), "wrong host");
  assert(body.model === "speech-2.8-hd" && body.stream === false && body.output_format === "hex", "body");
  assert(body.audio_setting.sample_rate === 44100 && body.audio_setting.format === "wav", "wav 44100");
  assert(body.voice_setting.voice_id === "female-shaonv", "voice");
  assert(body.text === SPOKEN.join("\n"), "text");
  assert(!JSON.stringify(body).includes("eleven_v4") && !JSON.stringify(body).includes("qwen"), "wrong model");
  const quoted = estimateSpokenAmount("0.0002", plan.spokenCharacters);
  assert(project.minimaxTts.quotes[Object.keys(project.minimaxTts.quotes)[0]].estimatedAmount === quoted, "one character price");
  assert(project.minimaxTts.quotes[Object.keys(project.minimaxTts.quotes)[0]].currency === "CNY", "cny");
  assert(project.elevenLabsTts === undefined, "elevenlabs bucket untouched");
});

await test("price and key do not fall back to ElevenLabs", async () => {
  let priceError = "";
  try { resolveMiniMaxUnitPrice({ ELEVENLABS_TTS_PRICE_CHARACTER: "0.0001", ELEVENLABS_MEDIA_PRICE_MUSIC_SECOND: "0.05" }); }
  catch (error) { priceError = error.message; }
  assert(priceError.includes("MINIMAX_TTS_PRICE_CHARACTER"), priceError);
  assert(!priceError.includes("0.0001") && !priceError.includes("0.05"), "foreign price leaked");
  let keyError = "";
  try { resolveMiniMaxApiKey({ ELEVENLABS_TTS_API_KEY: "elevenlabs-key-xxxx" }); }
  catch (error) { keyError = error.message; }
  assert(keyError.includes("MINIMAX_API_KEY_MISSING"), keyError);
  assert(!keyError.includes("elevenlabs-key-xxxx"), "elevenlabs key leaked");
  let modelError = "";
  try { resolveMiniMaxSettings({ MINIMAX_TTS_MODEL: "eleven_v4" }); }
  catch (error) { modelError = error.message; }
  assert(modelError.includes("speech-2.8-hd"), modelError);
  let hostError = "";
  try { resolveMiniMaxSettings({ MINIMAX_TTS_BASE_URL: "https://api.elevenlabs.io" }); }
  catch (error) { hostError = error.message; }
  assert(hostError === "MINIMAX_TTS_BASE_URL", hostError);
});

await test("duplicate instruction, unknown, and receipt resume do not resubmit", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mm-tts-"));
  const { project, quote, now } = prepared();
  let calls = 0;
  let persistedBeforeSend = 0;
  const persist = () => { persistedBeforeSend += 1; };
  const transport = async (request) => {
    assert(persistedBeforeSend >= 1, "intent was not persisted before send");
    assert(request.url === "https://api.minimaxi.com/v1/t2a_v2", request.url);
    calls += 1;
    throw new Error("socket hang up");
  };
  const first = await generateSpeech(project, { quoteId: quote.quoteId, idempotencyKey: "scene-1", transport, assetDir: dir, persist, settlement: "UNPAID_MOCK", now });
  assert(first.job.state === "UNKNOWN" && first.submitted && first.job.retryable === false, "unknown");
  const second = await generateSpeech(project, { quoteId: quote.quoteId, idempotencyKey: "scene-1", transport, assetDir: dir, persist, settlement: "UNPAID_MOCK", now });
  assert(second.reused && !second.submitted, "same key reused");
  let blocked = "";
  try {
    await generateSpeech(project, { quoteId: quote.quoteId, idempotencyKey: "scene-2", transport, assetDir: dir, persist, settlement: "UNPAID_MOCK", now });
  } catch (error) { blocked = error.message; }
  assert(blocked.includes("MINIMAX_TTS_UNCERTAIN_BLOCKING"), blocked);
  const resume = resumeSpeech(project, first.job.id);
  assert(resume.resubmitted === false && resume.state === "UNKNOWN", "resume does not submit");
  assert(calls === 1, `calls=${calls}`);
  rmSync(dir, { recursive: true, force: true });
});

await test("1008 and 2049 are terminal and do not call another provider", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mm-tts-err-"));
  const { project, quote, now } = prepared();
  const urls = [];
  let calls = 0;
  const balance = async (request) => {
    calls += 1;
    urls.push(request.url);
    return { status: 200, headers: { "trace-id": "bal_1" }, bytes: Buffer.from(JSON.stringify({ trace_id: "bal_1", base_resp: { status_code: 1008, status_msg: "insufficient balance" } })) };
  };
  const rejected = await generateSpeech(project, { quoteId: quote.quoteId, idempotencyKey: "bal-1", transport: balance, assetDir: dir, persist: () => {}, settlement: "UNPAID_MOCK", now });
  assert(rejected.job.state === "FAILED" && rejected.job.errorCode === "MINIMAX_TTS_INSUFFICIENT_BALANCE", rejected.job.errorCode);
  assert(rejected.job.errorMessage.includes("1008") && rejected.job.errorMessage.includes("Payment is required"), rejected.job.errorMessage);
  assert(rejected.job.fallbackProvider === null, "fallback");
  await generateSpeech(project, { quoteId: quote.quoteId, idempotencyKey: "bal-1", transport: balance, assetDir: dir, persist: () => {}, settlement: "UNPAID_MOCK", now });
  const invalid = async (request) => {
    calls += 1;
    urls.push(request.url);
    return { status: 200, headers: {}, bytes: Buffer.from(JSON.stringify({ base_resp: { status_code: 2049, status_msg: "invalid api key" } })) };
  };
  const badKey = await generateSpeech(project, { quoteId: quote.quoteId, idempotencyKey: "key-1", transport: invalid, assetDir: dir, persist: () => {}, settlement: "UNPAID_MOCK", now });
  assert(badKey.job.errorCode === "MINIMAX_TTS_INVALID_API_KEY", badKey.job.errorCode);
  assert(badKey.job.errorMessage.includes("invalid API key or wrong host"), badKey.job.errorMessage);
  assert(badKey.job.errorMessage.includes("api.minimaxi.com"), "host");
  assert(calls === 2 && urls.every((url) => url === "https://api.minimaxi.com/v1/t2a_v2"), urls.join(","));
  assert(!urls.some((url) => url.includes("elevenlabs")), "no elevenlabs");
  rmSync(dir, { recursive: true, force: true });
});

await test("mock success writes one wav receipt and does not invent subtitles", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mm-tts-ok-"));
  const { project, quote, now } = prepared();
  let calls = 0;
  const transport = async (request) => {
    calls += 1;
    const body = JSON.parse(request.body);
    assert(body.model === "speech-2.8-hd", "model");
    return mockT2aResponse(body);
  };
  const ok = await generateSpeech(project, { quoteId: quote.quoteId, idempotencyKey: "scene-ok", transport, assetDir: dir, persist: () => {}, settlement: "UNPAID_MOCK", now });
  assert(ok.job.state === "SUCCEEDED" && ok.job.externalSubmitCount === 1, "one submit");
  assert(ok.job.receipt.costs.length === 1 && ok.job.receipt.costs[0].component === "t2a_v2", "one receipt line");
  assert(ok.job.receipt.alignment === null && ok.job.receipt.subtitleTimingsInvented === false, "no invented timings");
  assert(ok.job.receipt.fallbackProvider === null && ok.job.settlement === "UNPAID_MOCK", "unpaid");
  const audio = readFileSync(ok.job.receipt.audio.path);
  assert(audio.subarray(0, 4).toString("ascii") === "RIFF", "wav");
  const again = await generateSpeech(project, { quoteId: quote.quoteId, idempotencyKey: "scene-ok", transport: async () => { throw new Error("should not send"); }, assetDir: dir, persist: () => {}, settlement: "UNPAID_MOCK", now });
  assert(again.reused && calls === 1, "receipt resume");
  const resume = resumeSpeech(project, ok.job.id);
  assert(resume.resubmitted === false && resume.resumed === true, "resume");
  rmSync(dir, { recursive: true, force: true });
});

await test("execute transport is blocked unless fetch is stubbed, and the stub is not a paid call", async () => {
  const { plan } = prepared();
  const request = buildT2aRequest(plan);
  let fetched = 0;
  globalThis.fetch = async () => { fetched += 1; throw new Error("should not fetch"); };
  const mismatch = createFetchTransport("test-minimax-key-never-live");
  let mismatchError = "";
  try {
    await mismatch({ method: "POST", url: "https://api.elevenlabs.io/v1/text-to-dialogue/with-timestamps", headers: {}, body: request.body });
  } catch (error) { mismatchError = error.message; }
  assert(mismatchError === "MINIMAX_TTS_URL_MISMATCH", mismatchError);
  assert(fetched === 0, "elevenlabs url fetched");
  let captured = null;
  globalThis.fetch = async (url, init) => {
    captured = { url: String(url), authorization: init.headers.Authorization, body: init.body };
    throw new Error("FETCH_BLOCKED_NO_SOCKET");
  };
  let blocked = "";
  try { await createFetchTransport("test-minimax-key-never-live")(request); }
  catch (error) { blocked = error.message; }
  assert(blocked === "FETCH_BLOCKED_NO_SOCKET", blocked);
  assert(captured.url === "https://api.minimaxi.com/v1/t2a_v2", captured.url);
  assert(captured.authorization === "Bearer test-minimax-key-never-live", "bearer");
  assert(JSON.parse(captured.body).model === "speech-2.8-hd", "model");
  globalThis.fetch = async () => { throw new Error("LIVE_MINIMAX_CALL_FORBIDDEN"); };
});

await test("cli mock director flow stays unpaid and does not open a socket", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mm-tts-cli-"));
  const storePath = join(dir, "store.json");
  const env = { ...process.env, ELEVENLABS_TTS_API_KEY: "elevenlabs-key-xxxx", ELEVENLABS_TTS_PRICE_CHARACTER: "0.0001" };
  delete env.MINIMAX_API_KEY;
  delete env.MINIMAX_TTS_PRICE_CHARACTER;
  const run = (args) => runCli(args.concat(["--store", storePath]), { env });
  const created = await run(["create", "--title", "末班车暗号"]);
  assert(created.ok, "create");
  await run(["save-script", "--text-file", join(here, "fixtures/moban-che-anhao/script.txt")]);
  await run(["approve-script", "--approved-by", "user:test"]);
  await run(["set-characters", "--characters-file", join(here, "fixtures/moban-che-anhao/characters.json")]);
  await run(["set-storyboard", "--scene-file", join(here, "fixtures/moban-che-anhao/scene.json")]);
  await run(["approve-scene", "--approved-by", "user:test"]);
  const missing = await run(["mm-tts-quote", "--voice-id", "female-shaonv", "--budget-cap", "10"]);
  assert(missing.ok === false && String(missing.output.error).includes("MINIMAX_TTS_PRICE_CHARACTER"), missing.output.error);
  const quote = await run(["mm-tts-quote", "--voice-id", "female-shaonv", "--unit-price", "0.0002", "--budget-cap", "10", "--currency", "CNY"]);
  assert(quote.ok && quote.output.paidCalls === 0 && quote.output.quote.model === "speech-2.8-hd" && quote.output.quote.singleOperation === true, "quote");
  const unauthorized = await run(["mm-tts-generate", "--mock", "--idempotency-key", "cli-scene"]);
  assert(unauthorized.ok === false, "generate without authorize");
  await run(["mm-tts-authorize", "--authorized-by", "user:test", "--quote-id", quote.output.quote.quoteId]);
  const generated = await run(["mm-tts-generate", "--mock", "--idempotency-key", "cli-scene", "--quote-id", quote.output.quote.quoteId]);
  assert(generated.ok && generated.output.job.state === "SUCCEEDED" && generated.output.paidCalls === 0, JSON.stringify(generated.output));
  assert(generated.output.job.externalSubmitCount === 1 && generated.output.job.requestUrl === "https://api.minimaxi.com/v1/t2a_v2", generated.output.job.requestUrl);
  assert(generated.output.job.fallbackProvider === null, "fallback");
  const reused = await run(["mm-tts-generate", "--mock", "--idempotency-key", "cli-scene", "--quote-id", quote.output.quote.quoteId]);
  assert(reused.output.reused === true && reused.output.submitted === false, "idempotent cli");
  const resume = await run(["mm-tts-resume", "--job-id", generated.output.job.id]);
  assert(resume.output.resume.resubmitted === false && resume.output.resume.resumed === true, "resume");
  const live = await run(["mm-tts-generate", "--execute", "--idempotency-key", "live-no"]);
  assert(live.ok === false && String(live.output.error).includes("MINIMAX_API_KEY_MISSING"), live.output.error);
  rmSync(dir, { recursive: true, force: true });
});

process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
if (failed) process.exit(1);
