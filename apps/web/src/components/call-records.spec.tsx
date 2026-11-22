// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { UsageSummaryView } from "@ai-drama/contracts";
import { CallRecords } from "./call-records";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const summary: UsageSummaryView = {
  scope: "episode_production",
  projectId: "work-1",
  episodeId: "ep-1",
  projects: [{ id: "work-1", label: "夜班证词" }],
  episodes: [{ id: "ep-1", label: "第 1 集", projectId: "work-1" }],
  totals: [
    { feature: "writing", featureLabel: "剧本编写", usageText: "未知", costText: "未知" },
    { feature: "storyboard", featureLabel: "分镜生图", usageText: "2 张", costText: "待回传费用" },
    { feature: "voice", featureLabel: "角色配音", usageText: "未知", costText: "未知" },
  ],
  records: [{
    id: "rec-1",
    taskId: "task-1",
    attempt: 1,
    feature: "storyboard",
    featureLabel: "分镜生图",
    vendor: "bailian",
    vendorLabel: "阿里云",
    model: "qwen-image-3.0",
    modelLabel: "Qwen Image",
    configVersion: "ver_locked",
    result: "succeeded",
    startedAt: "2026-11-21T02:00:00.000Z",
    usageText: "1 张",
    costText: "待回传费用",
    projectId: "work-1",
    projectLabel: "夜班证词",
    episodeId: "ep-1",
    episodeLabel: "第 1 集",
    kind: "production",
    credentialRef: "fc_secret_ref",
  }],
  footnote: "未知用量按原样保留，不会显示为 0。管理员测试不计入本集生产汇总。",
};

let calls: string[];

beforeEach(() => { calls = []; });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("shows usage by work and episode, and never prints an unknown amount as zero", async () => {
  vi.stubGlobal("fetch", vi.fn(async (input: string) => {
    const url = String(input);
    calls.push(url);
    if (url.includes("/auth/session")) {
      return json({ enabled: true, authenticated: true, role: "operator", username: "admin" });
    }
    if (url.includes("/usage/rec-1")) return json(summary.records[0]);
    return json(summary);
  }));
  render(<CallRecords />);
  expect(await screen.findByText("2 张")).toBeTruthy();
  expect(screen.getAllByText("待回传费用").length).toBeGreaterThan(0);
  expect(screen.getAllByText(/不会显示为 0/).length).toBeGreaterThan(0);
  expect(screen.queryByText("fc_secret_ref")).toBeNull();
  fireEvent.change(screen.getByLabelText("功能"), { target: { value: "writing" } });
  expect(screen.queryByRole("button", { name: /分镜生图/ })).toBeNull();
  expect(screen.getByText("2 张")).toBeTruthy();
  fireEvent.change(screen.getByLabelText("功能"), { target: { value: "all" } });
  expect(screen.queryByText(/^0$/)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: /分镜生图/ }));
  expect(await screen.findByRole("dialog", { name: "任务详情" })).toBeTruthy();
  expect(screen.getByText("ver_locked")).toBeTruthy();
  expect(within(screen.getByRole("dialog", { name: "任务详情" })).getByText("第 1 集")).toBeTruthy();
});

it("does not load call records for a creator", async () => {
  vi.stubGlobal("fetch", vi.fn(async (input: string) => {
    calls.push(String(input));
    return json({ enabled: true, authenticated: true, role: "creator", username: "creator-a" });
  }));
  render(<CallRecords />);
  expect(await screen.findByRole("heading", { name: "没有配置权限" })).toBeTruthy();
  expect(calls.some((url) => url.includes("/admin/usage"))).toBe(false);
});
