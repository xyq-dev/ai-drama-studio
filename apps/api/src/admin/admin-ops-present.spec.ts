import { describe, expect, it } from "vitest";
import { mediaRetryDecision } from "@ai-drama/domain";
import {
  adminRetryAllowed,
  assertNoCredential,
  assetName,
  assetType,
  deriveProductionStatus,
  jobAction,
  jobDisplayStatus,
  jobTypeLabel,
  maskCredential,
  ownerPresentation,
  recentTaskLabel,
  shortJobCode,
} from "./admin-ops-present";

describe("operator directory labels", () => {
  it("derives production status without treating project ACTIVE as finished", () => {
    expect(deriveProductionStatus({
      episodeCount: 1, completedEpisodeCount: 1, title: "海边的信", imageCount: 0, audioCount: 0, videoCount: 1, scriptCount: 1,
      openImageJobs: 0, openVoiceJobs: 0, openVideoJobs: 0,
    })).toBe("finished");
    expect(deriveProductionStatus({
      episodeCount: 1, completedEpisodeCount: 0, title: "雨夜来信", imageCount: 2, audioCount: 1, videoCount: 0, scriptCount: 1,
      openImageJobs: 0, openVoiceJobs: 1, openVideoJobs: 0,
    })).toBe("producing");
    expect(deriveProductionStatus({
      episodeCount: 1, completedEpisodeCount: 0, title: "南风过境", imageCount: 1, audioCount: 0, videoCount: 0, scriptCount: 1,
      openImageJobs: 1, openVoiceJobs: 0, openVideoJobs: 0,
    })).toBe("storyboard");
    expect(deriveProductionStatus({
      episodeCount: 1, completedEpisodeCount: 0, title: "旧巷灯火", imageCount: 0, audioCount: 0, videoCount: 0, scriptCount: 2,
      openImageJobs: 0, openVoiceJobs: 0, openVideoJobs: 0,
    })).toBe("script_review");
    expect(deriveProductionStatus({
      episodeCount: 1, completedEpisodeCount: 0, title: "草稿", imageCount: 0, audioCount: 0, videoCount: 0, scriptCount: 0,
      openImageJobs: 0, openVoiceJobs: 0, openVideoJobs: 0,
    })).toBe("draft");
    expect(deriveProductionStatus({
      episodeCount: 1, completedEpisodeCount: 0, title: "   ", imageCount: 0, audioCount: 0, videoCount: 0, scriptCount: 0,
      openImageJobs: 0, openVoiceJobs: 0, openVideoJobs: 0,
    })).toBe("unknown");
  });

  it.each([
    ["只有单镜合成", 1, 0, 2],
    ["只有演示视频", 1, 0, 1],
    ["三集只有两集完成", 3, 2, 6],
  ] as const)("%s 仍在制作中", (_reason, episodeCount, completedEpisodeCount, videoCount) => {
    expect(deriveProductionStatus({ title: "末班车", episodeCount, completedEpisodeCount, videoCount,
      imageCount: 0, audioCount: 0, scriptCount: 1, openImageJobs: 0, openVoiceJobs: 0, openVideoJobs: 0 })).toBe("producing");
  });

  it("区分原视频、单镜合成、集级合成和演示来源", () => {
    const shot = { kind: "COMPOSITE", episodeNo: 2, shotOrdinal: 3, metadataName: "第 2 集成片", isDemo: true, jobType: "shot_compose" as const };
    expect(assetName(shot)).toBe("第 2 集 · 镜头 3 单镜成片（演示）");
    expect(assetName({ ...shot, shotOrdinal: null, jobType: "episode_compose", isDemo: false })).toBe("第 2 集成片");
    expect(assetName({ ...shot, kind: "VIDEO", jobType: "video", metadataName: null })).toBe("第 2 集 · 镜头 3 视频（演示）");
  });

  it("labels jobs, including unknown outcomes that must not look successful", () => {
    expect(jobDisplayStatus("SUCCEEDED", null)).toBe("succeeded");
    expect(jobDisplayStatus("FAILED", "MOCK_REQUEST_UNKNOWN")).toBe("unknown");
    expect(jobDisplayStatus("needs_attention", null)).toBe("unknown");
    expect(jobDisplayStatus("partial", null)).toBe("unknown");
    expect(jobDisplayStatus("completed", null)).toBe("succeeded");
    expect(jobAction("failed")).toBe("retry");
    expect(jobAction("unknown")).toBe("view");
    expect(jobAction("canceled")).toBe("view");
    expect(jobTypeLabel("voice", false)).toBe("角色配音");
    expect(jobTypeLabel("subtitle", true)).toBe("字幕生成（演示）");
    expect(recentTaskLabel({ type: "image", demo: false, state: "RUNNING", errorCode: null })).toBe("分镜生图进行中");
    expect(recentTaskLabel({ type: null, demo: false, state: null, errorCode: null })).toBe("尚无生成任务");
  });

  it("keeps legacy works out of the login-able creator list", () => {
    expect(ownerPresentation({ username: "legacy-owner", status: "LEGACY" })).toEqual({
      name: "历史作品", legacy: true, loginable: false,
    });
    expect(ownerPresentation({ username: null, status: null }).loginable).toBe(false);
    expect(ownerPresentation({ username: "linxia", status: "ACTIVE" })).toEqual({
      name: "linxia", legacy: false, loginable: true,
    });
  });

  it("names previewable outputs and masks secrets", () => {
    expect(assetType("IMAGE").label).toBe("分镜图");
    expect(assetType("AUDIO").label).toBe("角色配音");
    expect(assetType("COMPOSITE").label).toBe("成片视频");
    expect(assetName({ kind: "IMAGE", episodeNo: 1, shotOrdinal: 3, metadataName: null, jobType: "image", isDemo: false })).toBe("第 1 集 · 镜号 03");
    expect(shortJobCode("00000000-0000-4000-8000-000000002184")).toBe("JOB-8580");
    expect(maskCredential("sk-synthetic-8hd")).toBe("sk-***8hd");
    expect(() => assertNoCredential({ target: "MiniMax · 已保存 (sk-***8hd)" }, ["sk-synthetic-8hd"])).not.toThrow();
    expect(() => assertNoCredential({ apiKey: "sk-synthetic-8hd" }, [])).toThrow(/OPERATION_LOG_SECRET/);
    expect(() => assertNoCredential({ note: "password is hunter2hunter2" }, ["hunter2hunter2"])).toThrow(/OPERATION_LOG_SECRET/);
  });

  it("refuses UNKNOWN and non-failed retries before a vendor call, and does not widen mediaRetryDecision", () => {
    expect(adminRetryAllowed({ kind: "MEDIA_IMAGE", state: "FAILED", errorCode: "MOCK_REQUEST_UNKNOWN" })).toEqual({
      ok: false, reason: "UNKNOWN_OUTCOME",
    });
    expect(adminRetryAllowed({ kind: "MEDIA_IMAGE", state: "CANCELED", errorCode: null }).ok).toBe(false);
    expect(adminRetryAllowed({ kind: "MEDIA_IMAGE", state: "RUNNING", errorCode: null }).ok).toBe(false);
    expect(adminRetryAllowed({ kind: "WRITING", state: "failed", errorCode: "timeout" })).toMatchObject({ ok: false });
    expect(adminRetryAllowed({ kind: "MEDIA_IMAGE", state: "FAILED", errorCode: "LEASE_EXPIRED" })).toEqual({ ok: true });
    expect(mediaRetryDecision({ kind: "MEDIA_IMAGE", state: "FAILED", errorCode: "MOCK_REQUEST_UNKNOWN" })).toEqual({
      allowed: false, reason: "UNKNOWN_OUTCOME",
    });
  });
});
