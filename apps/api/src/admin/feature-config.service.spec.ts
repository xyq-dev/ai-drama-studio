import { mkdtemp, rm, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FeatureConfigView, FeatureKey, FeatureVendor } from "@ai-drama/contracts";
import { FeatureConfigVault } from "./feature-config-vault";
import { FeatureUsageStore } from "./feature-usage-store";
import {
  FeatureConfigService,
  networkRefusingFeatureProbe,
  type FeatureProbe,
  type FeatureProbeInput,
  type LegacyFeatureSource,
} from "./feature-config.service";

const WS_A = "workspace-a";
const WS_B = "workspace-b";
const KEYS = {
  writing: "synthetic-writing-openai-key-aaa",
  writingDeepseek: "synthetic-writing-deepseek-key-bbb",
  image: "synthetic-image-openai-key-ccc",
  imageBailian: "synthetic-image-bailian-key-ddd",
  voice: "synthetic-voice-minimax-key-eee",
  legacyWriting: "synthetic-legacy-writing-key-fff",
  legacyImage: "synthetic-legacy-image-key-ggg",
};

const dirs: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function open(options: { probe?: FeatureProbe; legacy?: LegacyFeatureSource | null; homeWorkspaceId?: string } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "feature-config-"));
  dirs.push(dir);
  await chmod(dir, 0o700);
  const vault = await FeatureConfigVault.open({ path: join(dir, "feature-config.enc"), masterKey: randomBytes(32) });
  const usage = new FeatureUsageStore(join(dir, "feature-usage.json"));
  const seen: FeatureProbeInput[] = [];
  const probe = options.probe ?? (async (input) => {
    seen.push(input);
    return {
      ok: true,
      message: "模拟供应商已完成",
      usage: { status: "present" as const, amount: input.feature === "writing" ? 12 : input.feature === "storyboard" ? 1 : 8, unit: input.feature === "writing" ? "token" as const : input.feature === "storyboard" ? "image" as const : "character" as const },
      cost: { status: "present" as const, amount: "0.10", currency: "CNY" as const, source: "mock-vendor" },
    };
  });
  const service = await FeatureConfigService.open({
    vault, usage, probe, legacy: options.legacy ?? null, homeWorkspaceId: options.homeWorkspaceId ?? WS_A,
  });
  return { service, seen, dir };
}

function card(view: FeatureConfigView, feature: FeatureKey) {
  const found = view.features.find((item) => item.feature === feature);
  if (!found) throw new Error("missing feature");
  return found;
}

function slot(view: FeatureConfigView, feature: FeatureKey, vendor: FeatureVendor) {
  const found = card(view, feature).slots.find((item) => item.vendor === vendor);
  if (!found) throw new Error("missing slot");
  return found;
}

async function enable(service: FeatureConfigService, feature: FeatureKey, vendor: FeatureVendor, model: string, apiKey: string) {
  let view = await service.view();
  view = await service.saveDraft(feature, { expectedRevision: view.revision, vendor, model, secretAction: "replace", apiKey });
  const tested = await service.testDraft(feature, { expectedRevision: view.revision, vendor, confirmCost: true });
  const token = slot(tested.view, feature, vendor).testToken;
  if (!token) throw new Error("missing test token");
  return service.enable(feature, { expectedRevision: tested.view.revision, vendor, testToken: token });
}

describe("feature configuration", () => {
  it("keeps three features on their own credentials and does not move a draft key across vendors", async () => {
    const { service, seen } = await open();
    await enable(service, "writing", "openai", "gpt-6-astra", KEYS.writing);
    await enable(service, "storyboard", "openai", "gpt-image-2.5-sunburst", KEYS.image);
    await enable(service, "voice", "minimax", "speech-2.8-hd", KEYS.voice);
    const before = await Promise.all(["writing", "storyboard", "voice"].map((feature) => service.readBinding(feature as FeatureKey)));
    expect(before.map((item) => item?.secret)).toEqual([KEYS.writing, KEYS.image, KEYS.voice]);
    await enable(service, "storyboard", "bailian", "qwen-image-3.0", KEYS.imageBailian);
    const after = await Promise.all(["writing", "storyboard", "voice"].map((feature) => service.readBinding(feature as FeatureKey)));
    expect(after.map((item) => [item?.vendor, item?.secret])).toEqual([
      ["openai", KEYS.writing],
      ["bailian", KEYS.imageBailian],
      ["minimax", KEYS.voice],
    ]);
    let view = await service.view();
    view = await service.saveDraft("writing", { expectedRevision: view.revision, vendor: "deepseek", model: "deepseek-flash", secretAction: "replace", apiKey: KEYS.writingDeepseek });
    expect((await service.readBinding("writing"))?.secret).toBe(KEYS.writing);
    const tested = await service.testDraft("writing", { expectedRevision: view.revision, vendor: "deepseek", confirmCost: true });
    await service.enable("writing", { expectedRevision: tested.view.revision, vendor: "deepseek", testToken: slot(tested.view, "writing", "deepseek").testToken! });
    expect((await service.readBinding("writing"))?.secret).toBe(KEYS.writingDeepseek);
    view = await service.view();
    view = await service.saveDraft("writing", { expectedRevision: view.revision, vendor: "openai", model: "gpt-6-astra", secretAction: "keep" });
    const again = await service.testDraft("writing", { expectedRevision: view.revision, vendor: "openai", confirmCost: true });
    await service.enable("writing", { expectedRevision: again.view.revision, vendor: "openai", testToken: slot(again.view, "writing", "openai").testToken! });
    expect((await service.readBinding("writing"))?.secret).toBe(KEYS.writing);
    expect(JSON.stringify(await service.view())).not.toContain(KEYS.writing);
    expect(seen.every((call) => call.apiKey === KEYS.writing || call.apiKey === KEYS.image || call.apiKey === KEYS.imageBailian || call.apiKey === KEYS.voice || call.apiKey === KEYS.writingDeepseek)).toBe(true);
  });

  it("runs one mocked production path and keeps admin tests out of the episode total", async () => {
    const { service, seen } = await open();
    await enable(service, "storyboard", "bailian", "qwen-image-3.0", KEYS.imageBailian);
    const callsBefore = seen.length;
    const submitted = await service.submitProduction({
      feature: "storyboard", workspaceId: WS_A, projectId: "work-1", episodeId: "ep-1", taskId: "task-1",
      actorId: "creator-a", projectLabel: "雨夜来信", episodeLabel: "第 1 集", vendorRequestId: "vendor-req-1",
    });
    expect(submitted.ok).toBe(true);
    expect(seen.slice(callsBefore).map((call) => [call.kind, call.apiKey, call.model])).toEqual([["production", KEYS.imageBailian, "qwen-image-3.0"]]);
    const repeated = await service.submitProduction({
      feature: "storyboard", workspaceId: WS_A, projectId: "work-1", episodeId: "ep-1", taskId: "task-1",
      actorId: "creator-a", projectLabel: "雨夜来信", episodeLabel: "第 1 集", vendorRequestId: "vendor-req-1",
    });
    expect(repeated.message).toContain("没有重复调用");
    expect(seen.slice(callsBefore)).toHaveLength(1);
    await service.submitProduction({
      feature: "storyboard", workspaceId: WS_A, projectId: "work-1", episodeId: "ep-1", taskId: "task-1",
      actorId: "creator-a", projectLabel: "雨夜来信", episodeLabel: "第 1 集", vendorRequestId: "vendor-req-2",
    });
    const summary = await service.usageSummary({ workspaceId: WS_A, projectId: "work-1", episodeId: "ep-1" });
    expect(summary.records).toHaveLength(2);
    expect(summary.records.every((item) => item.kind === "production")).toBe(true);
    expect(summary.totals.find((item) => item.feature === "storyboard")?.usageText).toBe("2 张");
    expect(summary.totals.find((item) => item.feature === "writing")?.usageText).toBe("未知");
    expect(JSON.stringify(summary)).not.toContain(KEYS.imageBailian);
    const other = await service.usageSummary({ workspaceId: WS_B, projectId: "work-1", episodeId: "ep-1" });
    expect(other.records).toEqual([]);
    expect(other.totals.every((item) => item.usageText === "未知" && item.costText === "未知")).toBe(true);
    expect(other.totals.some((item) => item.usageText === "0" || item.costText.includes("0"))).toBe(false);
  });

  it("locks the submitted version when the live config later changes, and a repeated callback does not add usage", async () => {
    const { service } = await open();
    await enable(service, "voice", "minimax", "speech-2.8-hd", KEYS.voice);
    const first = await service.submitProduction({
      feature: "voice", workspaceId: WS_A, projectId: "work-1", episodeId: "ep-1", taskId: "voice-task",
      actorId: "creator-a", projectLabel: "雨夜来信", episodeLabel: "第 1 集", vendorRequestId: "voice-req-1",
    });
    await enable(service, "voice", "bailian", "qwen3-tts-flash", "synthetic-voice-bailian-key-hhh");
    const retry = await service.submitProduction({
      feature: "voice", workspaceId: WS_A, projectId: "work-1", episodeId: "ep-1", taskId: "voice-task",
      actorId: "creator-a", projectLabel: "雨夜来信", episodeLabel: "第 1 集", vendorRequestId: "voice-req-2",
    });
    expect(retry.configVersion).toBe(first.configVersion);
    expect(retry.vendor).toBe("minimax");
    expect(retry.model).toBe("speech-2.8-hd");
    const summary = await service.usageSummary({ workspaceId: WS_A, projectId: "work-1", episodeId: "ep-1" });
    const row = summary.records[0]!;
    expect(await service.recordCallback({
      vendorRequestId: "voice-req-1", workspaceId: WS_A,
      usage: { status: "present", amount: 999, unit: "character" },
      cost: { status: "present", amount: "9.99", currency: "CNY", source: "late" },
    })).toBe("duplicate");
    const again = await service.usageSummary({ workspaceId: WS_A, projectId: "work-1", episodeId: "ep-1" });
    expect(again.records.find((item) => item.id === row.id)?.usageText).toBe(row.usageText);
    await expect(service.usageDetail(WS_B, row.id)).rejects.toMatchObject({ code: "FEATURE_USAGE_NOT_FOUND" });
  });

  it("does not call a vendor when the choice is unconnected, unapproved, or over the writing budget", async () => {
    const { service, seen } = await open({
      probe: async () => { throw new Error("probe must not run"); },
    });
    const view = await service.view();
    await expect(service.saveDraft("voice", { expectedRevision: view.revision, vendor: "openai", model: "speech-2.8-hd", secretAction: "replace", apiKey: KEYS.voice }))
      .rejects.toMatchObject({ code: "FEATURE_VENDOR_UNCONNECTED" });
    await expect(service.saveDraft("writing", { expectedRevision: view.revision, vendor: "openai", model: "not-a-model", secretAction: "replace", apiKey: KEYS.writing }))
      .rejects.toMatchObject({ code: "FEATURE_MODEL_NOT_APPROVED" });
    const blocked = await FeatureConfigService.open({
      vault: await FeatureConfigVault.open({ path: join((await open()).dir, "other.enc"), masterKey: randomBytes(32) }),
      usage: new FeatureUsageStore(join(dirs[0]!, "usage-b.json")),
      policy: { writingCallsRemaining: async () => 0 },
    });
    const blank = await blocked.view();
    await expect(blocked.saveDraft("writing", { expectedRevision: blank.revision, vendor: "deepseek", model: "deepseek-flash", secretAction: "replace", apiKey: KEYS.writingDeepseek }))
      .rejects.toMatchObject({ code: "FEATURE_BUDGET_BLOCKED" });
    expect(seen).toEqual([]);
  });

  it("keeps a failed draft, refuses a stale enable, and runs one probe for a double click", async () => {
    let calls = 0;
    const { service } = await open({
      probe: async (input) => {
        calls += 1;
        if (input.vendorRequestId.endsWith("skip")) return { ok: false, message: `failed ${input.apiKey}`, usage: { status: "unknown" }, cost: { status: "pending" } };
        await new Promise((resolve) => setTimeout(resolve, 30));
        return { ok: true, usage: { status: "unknown" }, cost: { status: "unknown" } };
      },
    });
    let view = await service.view();
    view = await service.saveDraft("storyboard", { expectedRevision: view.revision, vendor: "openai", model: "gpt-image-2.5-sunburst", secretAction: "replace", apiKey: KEYS.image });
    const failing = await FeatureConfigService.open({
      vault: await FeatureConfigVault.open({ path: join(dirs[0]!, "feature-config.enc"), masterKey: randomBytes(32) }),
      usage: new FeatureUsageStore(join(dirs[0]!, "feature-usage.json")),
    });
    void failing;
    const failed = await service.testDraft("storyboard", { expectedRevision: view.revision, vendor: "openai", confirmCost: true });
    expect(failed.probe?.ok).toBe(true);
    // The shared mock above returns ok. Force a failure through a dedicated service.
    const dir = dirs[0]!;
    const master = randomBytes(32);
    const vault = await FeatureConfigVault.open({ path: join(dir, "fail.enc"), masterKey: master });
    const usage = new FeatureUsageStore(join(dir, "fail-usage.json"));
    let mode: "fail" | "hang" = "fail";
    let probeCalls = 0;
    const flaky = await FeatureConfigService.open({
      vault, usage,
      probe: async (input) => {
        probeCalls += 1;
        if (mode === "fail") return { ok: false, message: `nope ${input.apiKey}`, usage: { status: "unknown" }, cost: { status: "pending" } };
        await new Promise((resolve) => setTimeout(resolve, 40));
        return { ok: true, usage: { status: "present", amount: 1, unit: "image" }, cost: { status: "unknown" } };
      },
    });
    let draft = await flaky.view();
    draft = await flaky.saveDraft("storyboard", { expectedRevision: draft.revision, vendor: "openai", model: "gpt-image-2.5-sunburst", secretAction: "replace", apiKey: KEYS.image });
    const broken = await flaky.testDraft("storyboard", { expectedRevision: draft.revision, vendor: "openai", confirmCost: true });
    expect(broken.probe).toMatchObject({ ok: false, message: "测试没有通过，草稿已保留，可以重试。" });
    expect(JSON.stringify(broken)).not.toContain(KEYS.image);
    expect(slot(broken.view, "storyboard", "openai").keyConfigured).toBe(true);
    await expect(flaky.enable("storyboard", { expectedRevision: broken.view.revision, vendor: "openai", testToken: "tt_not-a-real-token" }))
      .rejects.toMatchObject({ code: "FEATURE_TEST_REQUIRED" });
    mode = "hang";
    const passed = await flaky.testDraft("storyboard", { expectedRevision: broken.view.revision, vendor: "openai", confirmCost: true });
    const token = slot(passed.view, "storyboard", "openai").testToken!;
    const saved = await flaky.saveDraft("storyboard", { expectedRevision: passed.view.revision, vendor: "openai", model: "gpt-image-2.5-sunburst", secretAction: "replace", apiKey: "synthetic-image-replaced-key-iii" });
    await expect(flaky.enable("storyboard", { expectedRevision: saved.revision, vendor: "openai", testToken: token }))
      .rejects.toMatchObject({ code: "FEATURE_TEST_REQUIRED" });
    const current = await flaky.view();
    const beforeParallel = probeCalls;
    const [left, right] = await Promise.all([
      flaky.testDraft("storyboard", { expectedRevision: current.revision, vendor: "openai", confirmCost: true }),
      flaky.testDraft("storyboard", { expectedRevision: current.revision, vendor: "openai", confirmCost: true }),
    ]);
    expect(left.probe?.ok).toBe(true);
    expect(right.probe?.ok).toBe(true);
    expect(probeCalls - beforeParallel).toBe(1);
    void calls;
  });

  it("reads only the matching legacy slot and still shows that live vendor", async () => {
    const calls: string[] = [];
    const legacy: LegacyFeatureSource = {
      live: async () => ({
        writing: { vendor: "deepseek", model: "deepseek-flash", vendorLabel: "DeepSeek", modelLabel: "DeepSeek Flash" },
        storyboard: { vendor: "bailian", model: "qwen-image-3.0", vendorLabel: "阿里云", modelLabel: "Qwen Image" },
        voice: { vendor: "minimax", model: "speech-2.8-hd", vendorLabel: "MiniMax", modelLabel: "speech-2.8-hd" },
      }),
      secret: async (feature, vendor) => {
        calls.push(`${feature}:${vendor}`);
        if (feature === "writing" && vendor === "deepseek") return KEYS.legacyWriting;
        if (feature === "storyboard" && vendor === "bailian") return KEYS.legacyImage;
        if (feature === "voice" && vendor === "minimax") return KEYS.voice;
        return null;
      },
    };
    const { service } = await open({ legacy });
    const view = await service.view();
    expect(card(view, "writing").firstTime).toBe(false);
    expect(card(view, "writing").live).toMatchObject({ source: "legacy", vendor: "deepseek", model: "deepseek-flash" });
    expect((await service.readBinding("writing"))?.secret).toBe(KEYS.legacyWriting);
    expect((await service.readBinding("storyboard"))?.secret).toBe(KEYS.legacyImage);
    expect(calls).toEqual(["writing:deepseek", "storyboard:bailian"]);
    expect(calls).not.toContain("writing:bailian");
    expect(JSON.stringify(view)).not.toContain(KEYS.legacyWriting);
  });

  it("refuses a real network probe when no mock is installed", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network"));
    const { service } = await open({ probe: networkRefusingFeatureProbe() });
    let view = await service.view();
    view = await service.saveDraft("voice", { expectedRevision: view.revision, vendor: "minimax", model: "speech-2.8-hd", secretAction: "replace", apiKey: KEYS.voice });
    const tested = await service.testDraft("voice", { expectedRevision: view.revision, vendor: "minimax", confirmCost: true });
    expect(tested.probe?.ok).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(slot(tested.view, "voice", "minimax").draftStatus).toBe("failed");
  });

  it("lets a failed draft be tested again without replacing the key", async () => {
    let calls = 0;
    const { service } = await open({ probe: async () => {
      calls += 1;
      return calls === 1
        ? { ok: false, message: "transient" }
        : { ok: true, message: "ok", usage: { status: "unknown" }, cost: { status: "unknown" } };
    } });
    let view = await service.view();
    view = await service.saveDraft("voice", { expectedRevision: view.revision, vendor: "minimax", model: "speech-2.8-hd", secretAction: "replace", apiKey: KEYS.voice });
    const failed = await service.testDraft("voice", { expectedRevision: view.revision, vendor: "minimax", confirmCost: true });
    expect(slot(failed.view, "voice", "minimax").draftStatus).toBe("failed");
    const again = await service.testDraft("voice", { expectedRevision: failed.view.revision, vendor: "minimax", confirmCost: true });
    expect(again.probe?.ok).toBe(true);
    expect(calls).toBe(2);
  });

  it("calls the probe once when two submissions share a vendor request id", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let calls = 0;
    const { service } = await open({ probe: async (input) => {
      if (input.kind === "production") {
        calls += 1;
        await gate;
      }
      return { ok: true, message: "ok", usage: { status: "present", amount: 1, unit: "image" }, cost: { status: "unknown" } };
    } });
    await enable(service, "storyboard", "openai", "gpt-image-2.5-sunburst", KEYS.image);
    const input = {
      feature: "storyboard" as const, workspaceId: WS_A, projectId: "work-1", episodeId: "ep-1", taskId: "task-race",
      actorId: "creator", projectLabel: "作品", episodeLabel: "第 1 集", vendorRequestId: "vendor-request-same-01",
    };
    const first = service.submitProduction(input);
    const second = service.submitProduction(input);
    release();
    const [left, right] = await Promise.all([first, second]);
    expect(calls).toBe(1);
    expect(left.ok).toBe(true);
    expect(right).toEqual(left);
  });

  it("keeps a locked credential after later keys push the vault past the prune limit", async () => {
    const { service } = await open();
    await enable(service, "storyboard", "bailian", "qwen-image-3.0", KEYS.imageBailian);
    await service.submitProduction({
      feature: "storyboard", workspaceId: WS_A, projectId: "work-1", episodeId: "ep-1", taskId: "locked-task",
      actorId: "creator", projectLabel: "作品", episodeLabel: "第 1 集", vendorRequestId: "vendor-request-lock-01",
    });
    const locked = await service.credentialForTask("storyboard", WS_A, "locked-task");
    expect(locked?.apiKey).toBe(KEYS.imageBailian);
    let view = await service.view();
    view = await service.saveDraft("storyboard", { expectedRevision: view.revision, vendor: "openai", model: "gpt-image-2.5-sunburst", secretAction: "replace", apiKey: KEYS.image });
    const tested = await service.testDraft("storyboard", { expectedRevision: view.revision, vendor: "openai", confirmCost: true });
    const token = slot(tested.view, "storyboard", "openai").testToken;
    if (!token) throw new Error("missing token");
    await service.enable("storyboard", { expectedRevision: tested.view.revision, vendor: "openai", testToken: token });
    for (let index = 0; index < 45; index += 1) {
      const current = await service.view();
      await service.saveDraft("voice", {
        expectedRevision: current.revision, vendor: "minimax", model: "speech-2.8-hd", secretAction: "replace",
        apiKey: `synthetic-rotated-voice-key-${String(index).padStart(2, "0")}-xxxx`,
      });
    }
    expect((await service.credentialForTask("storyboard", WS_A, "locked-task"))?.apiKey).toBe(KEYS.imageBailian);
  });
});
