import { describe, expect, it } from "vitest";
import {
  autoErrorText,
  autoHeadline,
  autoOutputRefused,
  autoResumeRefused,
  autoUserReviseRefused,
  isAutoCreationAuthSessionLoss,
  normalizeAutoOptions,
} from "./auto-creation-client";
import { TitleWritingError } from "./title-writing-client";
import type { AutoCreationOptionsView, AutoCreationRunView } from "@ai-drama/contracts";

describe("normalizeAutoOptions", () => {
  it("defaults media.imageProviders to [] when older servers omit it", () => {
    const legacy = {
      enabled: true,
      code: "AUTO_CREATION_READY",
      storageReady: true,
      operatorTokenRequired: false,
      defaultProvider: "deepseek",
      providers: [],
      maxCallsPerDay: 30,
      maxActiveRuns: 1,
      billing: "unknown",
      episodePlan: { minEpisodes: 1, maxEpisodes: 6, defaultEpisodes: 1, secondsChoices: [60, 90], defaultSeconds: 60 },
      episodePlanReady: true,
      revisionRounds: { max: 2, default: 2 },
      maxOutputTokensPerCall: 4096,
      maxPromptChars: 40000,
      research: {
        fetchEnabled: false, allowedHosts: [], builtInSources: 0, readableMarketSources: 0,
        expectedMode: "limited", visualAnalysis: false,
      },
      media: { realProviders: [], mockOnly: true, missing: [] },
    } as unknown as AutoCreationOptionsView;
    const normalized = normalizeAutoOptions(legacy);
    expect(normalized?.media.imageProviders).toEqual([]);
  });
});

describe("auto-creation refusal wording", () => {
  it("prompt v9: a method id outside the run's catalog is a refused answer with its own wording and field", () => {
    const code = "unknown_reference@contentStructure[0].referenceId";
    expect(autoOutputRefused(code)).toBe(true);
    expect(autoErrorText(code)).toBe("回答选择的方法片段编号不在本次引用目录中，已拒收，后续阶段没有发送。位置：contentStructure[0].referenceId。");
    expect(autoErrorText("unknown_reference")).not.toContain("未识别的问题");
  });

  it("the earlier evidence codes and the viewing-time branch read as before", () => {
    expect(autoOutputRefused("unknown_source@facts[0].sourceId")).toBe(true);
    expect(autoErrorText("unknown_source@facts[0].sourceId")).toBe("研究结论引用了不存在的资料编号，已拒收。位置：facts[0].sourceId。");
    expect(autoOutputRefused("evidence_not_in_source@contentStructure[2].reference.quote")).toBe(true);
    expect(autoErrorText("evidence_not_in_source@contentStructure[2].reference.quote")).toBe(
      "研究结论的引文在资料中找不到，已拒收。位置：contentStructure[2].reference.quote。");
    const viewing = "unsourced_number@contentStructure[0].application.why:digits+market_statistic+viewing_duration+viewing_habit";
    expect(autoOutputRefused(viewing)).toBe(true);
    expect(autoErrorText(viewing)).toContain("程序命中了「观看习惯词」");
    expect(autoOutputRefused("auth")).toBe(false);
  });
});

describe("phase 5 auth expiry vs definite refusal", () => {
  it("does not treat AUTH_SESSION_EXPIRED / AUTH_REQUIRED as a definite resume or revise refusal", () => {
    const expired = new TitleWritingError(401, "AUTH_SESSION_EXPIRED", "登录已过期", null);
    const required = new TitleWritingError(401, "AUTH_REQUIRED", "请先登录", null);
    const stale = new TitleWritingError(409, "AUTO_CREATION_CONFIRMATION_STALE", "确认已过期", null);
    expect(isAutoCreationAuthSessionLoss(expired)).toBe(true);
    expect(isAutoCreationAuthSessionLoss(required)).toBe(true);
    expect(isAutoCreationAuthSessionLoss(stale)).toBe(false);
    expect(autoResumeRefused(expired)).toBe(false);
    expect(autoResumeRefused(required)).toBe(false);
    expect(autoResumeRefused(stale)).toBe(true);
    expect(autoUserReviseRefused(expired)).toBe(false);
    expect(autoUserReviseRefused(required)).toBe(false);
    expect(autoUserReviseRefused(stale)).toBe(true);
  });

  it("completed machine-pass headline still requires human review and is not publishable wording", () => {
    const run = { state: "completed", quality: "passed", stages: [] } as unknown as AutoCreationRunView;
    expect(autoHeadline(run)).toBe("剧本包已完成（机器检查通过，仍需人工审核）");
    expect(autoHeadline(run)).not.toMatch(/可发布|一键发布/);
  });
});
