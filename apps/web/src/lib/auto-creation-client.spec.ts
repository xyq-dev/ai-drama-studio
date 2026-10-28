import { describe, expect, it } from "vitest";
import { autoErrorText, autoOutputRefused } from "./auto-creation-client";

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
