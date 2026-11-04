import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runCli } from "./cli.mjs";
import {
  DEFAULT_VOICE_CATALOG, assessAlignment, authorizeQuote, buildDialogueRequest, buildPerformancePlan,
  buildSubtitles, deriveLineStem, estimateSpokenAmount, generateScene, mockDialogueResponse, pickVoice,
  quoteScene, resolveTtsApiKey, resolveUnitPrice, resumeTask,
} from "./elevenlabs-tts.mjs";
import { approveScene, approveScript, createProject, emptyStore, saveScript, setCharacters, setStoryboard } from "./store.mjs";

let passed = 0;
let failed = 0;
const here = dirname(fileURLToPath(import.meta.url));
const scriptText = readFileSync(join(here, "fixtures/moban-che-anhao/script.txt"), "utf8");
const FIXED = [
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
  const plan = buildPerformancePlan(project, { outputFormat: "pcm_44100" });
  pickVoice(project, { character: "阿岚", candidateId: "alan-clear" });
  pickVoice(project, { character: "老周", candidateId: "zhou-low" });
  const now = Date.parse("2026-11-04T00:00:00.000Z");
  const quote = quoteScene(project, { unitPrice: "0.0001", maximumAmount: "2", now });
  const authorization = authorizeQuote(project, { quoteId: quote.quoteId, authorizedBy: "user:test", now });
  return { store, project, plan, quote, authorization, now };
  return { store, project, plan, quote, authorization };
}

await test("fixture lines stay exact and performance tags stay out of the request", async () => {
  const { project, plan } = prepared();
  assert(plan.lines.map((line) => line.text).join("\n") === FIXED.join("\n"), "lines rewritten");
  assert(plan.model === "eleven_v4" && plan.provider === "elevenlabs-tts", "provider");
  assert(plan.sceneContext === "rain-night bus stop", "scene");
  assert(plan.roles["阿岚"].delivery === "young female, slightly tense, clear", "alan delivery");
  assert(plan.roles["老周"].delivery === "middle-aged male, low, short phrases", "zhou delivery");
  assert(DEFAULT_VOICE_CATALOG.roles["阿岚"].length === 3 && DEFAULT_VOICE_CATALOG.roles["老周"].length === 3, "3 candidates");
  const request = buildDialogueRequest(plan, [project.elevenLabsTts.voicePicks["阿岚"], project.elevenLabsTts.voicePicks["老周"], project.elevenLabsTts.voicePicks["阿岚"], project.elevenLabsTts.voicePicks["老周"]]);
  const body = JSON.parse(request.body);
  assert(body.model_id === "eleven_v4", "model_id");
  assert(request.url.includes("output_format=pcm_44100") && request.url.includes("/v1/text-to-dialogue/with-timestamps"), "endpoint");
  assert(!request.url.includes("/v1/music"), "not music");
  assert(body.inputs.length === 4 && body.inputs[0].text === FIXED[0], "one multi-turn body");
  for (const key of ["speed", "style", "voice_settings", "audio_effects", "next_text", "ssml"]) assert(!(key in body), key);
  assert(!JSON.stringify(body).includes("slightly tense"), "tag leaked into speech");
  assert(!JSON.stringify(body).includes("music_v2") && !JSON.stringify(body).includes("qwen"), "wrong model");
  const quoted = estimateSpokenAmount("0.0001", plan.spokenCharacters);
  assert(project.elevenLabsTts.quotes[Object.keys(project.elevenLabsTts.quotes)[0]].estimatedAmount === quoted, "one character price");
  assert(project.elevenLabsTts.quotes[Object.keys(project.elevenLabsTts.quotes)[0]].separateLineFees === false, "no per-line fee");
});

await test("speech price and key do not fall back to music", async () => {
  let priceError = "";
  try { resolveUnitPrice({ ELEVENLABS_MEDIA_PRICE_MUSIC_SECOND: "0.05", ELEVENLABS_MEDIA_API_KEY: "music-key-xxxx" }); }
  catch (error) { priceError = error.message; }
  assert(priceError.includes("ELEVENLABS_TTS_PRICE_CHARACTER"), priceError);
  assert(!priceError.includes("0.05"), "music price leaked");
  let keyError = "";
  try { resolveTtsApiKey({ ELEVENLABS_MEDIA_API_KEY: "music-key-xxxx" }); }
  catch (error) { keyError = error.message; }
  assert(keyError.includes("ELEVENLABS_TTS_API_KEY_MISSING"), keyError);
  assert(!keyError.includes("music-key-xxxx"), "music key leaked");
});

await test("duplicate instruction, unknown, and receipt resume do not resubmit", async () => {
  const dir = mkdtempSync(join(tmpdir(), "el-tts-"));
  const { project, quote, now } = prepared();
  let calls = 0;
  let persistedBeforeSend = 0;
  const persist = () => { persistedBeforeSend += 1; };
  const transport = async () => {
    assert(persistedBeforeSend >= 1, "intent was not persisted before send");
    calls += 1;
    throw new Error("socket hang up");
  };
  const first = await generateScene(project, { quoteId: quote.quoteId, idempotencyKey: "scene-1", transport, assetDir: dir, persist, settlement: "UNPAID_MOCK", now });
  assert(first.job.state === "UNKNOWN" && first.submitted, "unknown");
  const second = await generateScene(project, { quoteId: quote.quoteId, idempotencyKey: "scene-1", transport, assetDir: dir, persist, settlement: "UNPAID_MOCK", now });
  assert(second.reused && !second.submitted, "same key reused");
  let blocked = "";
  try {
    await generateScene(project, { quoteId: quote.quoteId, idempotencyKey: "scene-2", transport, assetDir: dir, persist, settlement: "UNPAID_MOCK", now });
  } catch (error) { blocked = error.message; }
  assert(blocked.includes("TTS_UNCERTAIN_BLOCKING"), blocked);
  first.job.state = "INTENT";
  const third = await generateScene(project, { quoteId: quote.quoteId, idempotencyKey: "scene-1", transport, assetDir: dir, persist, settlement: "UNPAID_MOCK", now });
  assert(third.reused && calls === 1, `calls=${calls}`);
  const resume = resumeTask(project, first.job.id);
  assert(resume.resubmitted === false && resume.state === "INTENT", "resume does not submit");
  rmSync(dir, { recursive: true, force: true });
});

await test("rejection is surfaced once and success maps subtitles without a second fee", async () => {
  const dir = mkdtempSync(join(tmpdir(), "el-tts-ok-"));
  const { project, quote, plan, now } = prepared();
  const seen = [];
  let calls = 0;
  const persist = () => {};
  const rejectTransport = async (request) => {
    calls += 1;
    seen.push(JSON.parse(request.body));
    return { status: 422, headers: { "request-id": "reject-1" }, bytes: Buffer.from(JSON.stringify({ detail: "model eleven_v4 is not enabled for this account" })) };
  };
  const rejected = await generateScene(project, { quoteId: quote.quoteId, idempotencyKey: "reject-1", transport: rejectTransport, assetDir: dir, persist, settlement: "UNPAID_MOCK", now });
  assert(rejected.job.state === "FAILED" && rejected.job.errorMessage.includes("eleven_v4"), rejected.job.errorMessage);
  assert(rejected.job.errorMessage.includes("pcm_44100"), "format surfaced");
  assert(!rejected.job.errorMessage.includes("mp3_"), "downgraded");
  await generateScene(project, { quoteId: quote.quoteId, idempotencyKey: "reject-1", transport: rejectTransport, assetDir: dir, persist, settlement: "UNPAID_MOCK", now });
  assert(calls === 1 && seen[0].model_id === "eleven_v4", "no downgrade retry");

  calls = 0;
  const okTransport = async (request) => {
    calls += 1;
    assert(!request.url.includes("output_format=mp3"), "lossy fallback");
    return mockDialogueResponse(JSON.parse(request.body));
  };
  const ok = await generateScene(project, { quoteId: quote.quoteId, idempotencyKey: "scene-ok", transport: okTransport, assetDir: dir, persist, settlement: "UNPAID_MOCK", now });
  assert(ok.job.state === "SUCCEEDED" && ok.job.externalSubmitCount === 1, "one submit");
  assert(ok.job.receipt.costs.length === 1 && ok.job.receipt.costs[0].component === "scene-dialogue", "one receipt line");
  assert(ok.job.receipt.separateLineFees === false, "lines are not fees");
  const again = await generateScene(project, { quoteId: quote.quoteId, idempotencyKey: "scene-ok", transport: okTransport, assetDir: dir, persist, settlement: "UNPAID_MOCK", now });
  assert(again.reused && calls === 1, "receipt resume");
  const subtitles = buildSubtitles(ok.job.receipt);
  assert(subtitles.cues.map((cue) => cue.text).join("\n") === FIXED.join("\n"), "subtitle text");
  assert(!subtitles.vtt.includes("slightly tense") && !subtitles.vtt.includes("middle-aged"), "performance tag in vtt");
  assert(subtitles.vtt.startsWith("WEBVTT"), "vtt");
  const stem = deriveLineStem(project, { jobId: ok.job.id, lineIndex: 0, assetDir: dir });
  assert(stem.externalSubmitCount === 0 && stem.feeRegistered === false && stem.cleanSoloStem === false, "stem is not a new take");
  assert(stem.parentJobId === ok.job.id && stem.text === FIXED[0], "lineage");
  assert(ok.job.externalSubmitCount === 1 && ok.job.receipt.costs.length === 1, "parent fee unchanged");
  ok.job.receipt.voiceSegments[1].start_time_seconds = 0;
  const overlapped = deriveLineStem(project, { jobId: ok.job.id, lineIndex: 0, assetDir: dir });
  assert(overlapped.overlap === true && overlapped.cleanSoloStem === false, "overlap not faked as solo");
  let stale = "";
  try { assessAlignment([{ voice_id: "a" }, { voice_id: "b" }], { alignment: null, voice_segments: [] }); }
  catch (error) { stale = error.message; }
  assert(stale === "TTS_ALIGNMENT_INSUFFICIENT", stale);
  assert(plan.dryDialogue === true, "dry");
  rmSync(dir, { recursive: true, force: true });
});

await test("missing alignment does not invent a subtitle clock", async () => {
  const dir = mkdtempSync(join(tmpdir(), "el-tts-align-"));
  const { project, quote, now } = prepared();
  const transport = async () => ({
    status: 200,
    headers: { "request-id": "align-1" },
    bytes: Buffer.from(JSON.stringify({ audio_base64: Buffer.from("pcm").toString("base64"), voice_segments: [], alignment: null })),
  });
  const result = await generateScene(project, { quoteId: quote.quoteId, idempotencyKey: "align-1", transport, assetDir: dir, persist: () => {}, settlement: "UNPAID_MOCK", now });
  assert(result.job.state === "ALIGNMENT_INSUFFICIENT", result.job.state);
  let message = "";
  try { buildSubtitles(result.job.receipt); }
  catch (error) { message = error.message; }
  assert(message === "TTS_ALIGNMENT_INSUFFICIENT", message);
  const second = await generateScene(project, { quoteId: quote.quoteId, idempotencyKey: "align-1", transport: async () => { throw new Error("should not send"); }, assetDir: dir, persist: () => {}, settlement: "UNPAID_MOCK", now });
  assert(second.reused, "alignment failure is not retried");
  rmSync(dir, { recursive: true, force: true });
});

await test("cli mock director flow stays unpaid", async () => {
  const dir = mkdtempSync(join(tmpdir(), "el-tts-cli-"));
  const storePath = join(dir, "store.json");
  const env = { ...process.env, ELEVENLABS_MEDIA_API_KEY: "music-key-xxxx", ELEVENLABS_MEDIA_PRICE_MUSIC_SECOND: "0.05" };
  delete env.ELEVENLABS_TTS_API_KEY;
  delete env.ELEVENLABS_TTS_PRICE_CHARACTER;
  const run = (args) => runCli(args.concat(["--store", storePath]), { env });
  const created = await run(["create", "--title", "末班车暗号"]);
  assert(created.ok, "create");
  await run(["save-script", "--text-file", join(here, "fixtures/moban-che-anhao/script.txt")]);
  await run(["approve-script", "--approved-by", "user:test"]);
  await run(["set-characters", "--characters-file", join(here, "fixtures/moban-che-anhao/characters.json")]);
  await run(["set-storyboard", "--scene-file", join(here, "fixtures/moban-che-anhao/scene.json")]);
  await run(["approve-scene", "--approved-by", "user:test"]);
  const candidates = await run(["voice-candidates", "--voices-file", join(here, "fixtures/moban-che-anhao/voices.json")]);
  assert(candidates.output.candidates.length === 2, "two roles");
  assert(candidates.output.candidates.every((role) => role.candidates.length === 3), "three each");
  await run(["pick-voice", "--character", "阿岚", "--candidate", "alan-clear", "--voices-file", join(here, "fixtures/moban-che-anhao/voices.json")]);
  await run(["pick-voice", "--character", "老周", "--candidate", "zhou-low", "--voices-file", join(here, "fixtures/moban-che-anhao/voices.json")]);
  const missing = await run(["tts-quote", "--budget-cap", "2"]);
  assert(missing.ok === false && String(missing.output.error).includes("ELEVENLABS_TTS_PRICE_CHARACTER"), missing.output.error);
  const quote = await run(["tts-quote", "--unit-price", "0.0001", "--budget-cap", "2", "--currency", "USD"]);
  assert(quote.ok && quote.output.paidCalls === 0 && quote.output.quote.singleOperation === true, "quote");
  const unauthorized = await run(["tts-generate", "--mock", "--idempotency-key", "cli-scene"]);
  assert(unauthorized.ok === false, "generate without authorize");
  await run(["tts-authorize", "--authorized-by", "user:test", "--quote-id", quote.output.quote.quoteId]);
  const generated = await run(["tts-generate", "--mock", "--idempotency-key", "cli-scene", "--quote-id", quote.output.quote.quoteId]);
  assert(generated.ok && generated.output.job.state === "SUCCEEDED" && generated.output.paidCalls === 0, JSON.stringify(generated.output));
  assert(generated.output.job.externalSubmitCount === 1 && generated.output.job.costs.length === 1, "one cost");
  const reused = await run(["tts-generate", "--mock", "--idempotency-key", "cli-scene", "--quote-id", quote.output.quote.quoteId]);
  assert(reused.output.reused === true && reused.output.submitted === false, "idempotent cli");
  const resume = await run(["tts-resume", "--job-id", generated.output.job.id]);
  assert(resume.output.resume.resubmitted === false && resume.output.resume.resumed === true, "resume");
  const subtitles = await run(["tts-subtitles", "--job-id", generated.output.job.id]);
  assert(subtitles.output.cues.map((cue) => cue.text).join("\n") === FIXED.join("\n"), "cli subtitles");
  await run(["tts-select", "--job-id", generated.output.job.id]);
  const redo = await run(["tts-redo", "--job-id", generated.output.job.id, "--line-index", "0"]);
  assert(redo.output.paidCalls === 0 && redo.output.stem.cleanSoloStem === false && redo.output.stem.externalSubmitCount === 0, "redo");
  const exported = await run(["tts-export", "--job-id", generated.output.job.id, "--out", join(dir, "out")]);
  assert(exported.output.manifest.dryDialogue === true && exported.output.manifest.denoised === false && exported.output.manifest.speedAdjusted === false, "export");
  const vtt = readFileSync(join(dir, "out/dialogue.vtt"), "utf8");
  assert(vtt.includes(FIXED[3]) && !vtt.includes("short phrases"), "exported cues");
  const live = await runCli(["tts-generate", "--live", "--mock", "--idempotency-key", "nope"], {
    env: { ...env, ADS_SESSION_COOKIE: "session=fake", ADS_CSRF_TOKEN: "csrf-fake", ADS_ORIGIN: "https://drama.playhubs.cn" },
  });
  assert(live.ok === false && live.exitCode === 2, "live tts refused");
  rmSync(dir, { recursive: true, force: true });
});

process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
process.exitCode = failed ? 1 : 0;
