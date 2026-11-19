// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import {
  SPEECH_NOT_ENABLED_DETAIL,
  SPEECH_NOT_ENABLED_TITLE,
  SPEECH_SINGLE_FAILURE_DETAIL,
  SPEECH_SINGLE_FAILURE_TITLE,
} from "./speech-panel";

describe("speech not-enabled vs single-failure copy", () => {
  it("keeps the exact platform-not-enabled sentence required by the brief", () => {
    expect(SPEECH_NOT_ENABLED_TITLE).toBe("配音服务暂未启用，请联系管理员。");
    expect(SPEECH_NOT_ENABLED_DETAIL).toContain("这是服务尚未配置");
    expect(SPEECH_NOT_ENABLED_DETAIL).toContain("不是这次任务失败");
    expect(SPEECH_NOT_ENABLED_DETAIL).toContain("不要反复点击生成配音");
  });

  it("uses a different sentence for one-off task failures", () => {
    expect(SPEECH_SINGLE_FAILURE_TITLE).toBe("单次生成失败，可以重试");
    expect(SPEECH_SINGLE_FAILURE_DETAIL).toContain("单次任务失败");
    expect(SPEECH_SINGLE_FAILURE_DETAIL).not.toBe(SPEECH_NOT_ENABLED_DETAIL);
    expect(SPEECH_SINGLE_FAILURE_TITLE).not.toContain("配音服务暂未启用");
  });
});
