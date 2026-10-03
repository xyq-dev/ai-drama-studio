// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { StudioClient } from "../lib/studio-client";
import { ProjectCostSummary } from "./project-cost-summary";

const PROJECT = "22222222-2222-4222-8222-222222222222";
const OTHER = "34343434-3434-4434-8434-343434343434";

function summary(projectId: string, currencies: unknown[] = [], ledgerRowCount = currencies.length) {
  return {
    schema: "m4.project.cost-summary.v1",
    projectId,
    snapshotAt: "2026-10-03T02:00:00.000Z",
    ledgerRowCount,
    currencies,
    coverage: {
      jobCount: 0,
      attemptCount: 0,
      jobsWithoutLedgerCount: 0,
      providerBoundAttemptsWithoutLedgerCount: 0,
      localComposeAttemptCount: 0,
      ledgerRowsWithoutAttemptCount: 0,
    },
    boundary: { localEncodeCostMetered: false, totalProductionCostKnown: false },
  };
}

function usdZero() {
  return {
    currency: "USD",
    actualAmount: "0.00000000",
    outstandingEstimatedAmount: "0.00000000",
    actualEntryCount: 1,
    outstandingEstimatedEntryCount: 0,
    supersededEstimatedEntryCount: 0,
  };
}

afterEach(cleanup);

describe("project cost summary", () => {
  it("stays collapsed, then shows an empty ledger without calling it free", async () => {
    const client = new StudioClient(() => Promise.resolve(json(summary(PROJECT, [], 0))));
    render(createElement(ProjectCostSummary, { projectId: PROJECT, client }));
    expect(screen.queryByText("没有已记录的账本行。没有记录不等于免费。")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "已记录成本" }));
    expect(await screen.findByText("没有已记录的账本行。没有记录不等于免费。")).toBeTruthy();
    expect(screen.getByText("包含本项目历史调用；本地编码等成本尚未计量。")).toBeTruthy();
    expect(document.body.textContent).not.toContain("整剧免费");
    expect(document.body.textContent).not.toContain("成本完整");
  });

  it("shows a recorded zero actual separately from an empty ledger", async () => {
    const client = new StudioClient(() => Promise.resolve(json(summary(PROJECT, [usdZero()], 1))));
    render(createElement(ProjectCostSummary, { projectId: PROJECT, client }));
    fireEvent.click(screen.getByRole("button", { name: "已记录成本" }));
    expect(await screen.findByText("已记录实际金额 0.00000000")).toBeTruthy();
    expect(screen.getByText("实际 1 笔 · 未结算估算 0 笔")).toBeTruthy();
    expect(screen.queryByText("没有已记录的账本行。没有记录不等于免费。")).toBeNull();
    expect(document.body.textContent).not.toContain("整剧免费");
  });

  it("keeps the last snapshot when refresh fails and drops a late response after switching or unmount", async () => {
    let release: (value: Response) => void = () => undefined;
    let mode: "first" | "hold" = "first";
    const client = new StudioClient((input) => {
      if (mode === "hold") return new Promise<Response>((resolve) => { release = resolve; });
      const projectId = input.includes(OTHER) ? OTHER : PROJECT;
      return Promise.resolve(json(summary(projectId, projectId === PROJECT ? [usdZero()] : [], projectId === PROJECT ? 1 : 0)));
    });
    const view = render(createElement(ProjectCostSummary, { projectId: PROJECT, client }));
    fireEvent.click(screen.getByRole("button", { name: "已记录成本" }));
    expect(await screen.findByText("已记录实际金额 0.00000000")).toBeTruthy();
    mode = "hold";
    fireEvent.click(screen.getByRole("button", { name: "刷新已记录成本" }));
    expect(screen.getByText("正在读取已记录成本")).toBeTruthy();
    release(json({ error: { code: "UNAVAILABLE", message: "读取中断" } }, 503));
    expect(await screen.findByText(/刷新没有完成，以下仍是上次读取的结果/)).toBeTruthy();
    expect(screen.getByText("已记录实际金额 0.00000000")).toBeTruthy();
    expect(screen.getByText("读取时间 2026-10-03T02:00:00.000Z")).toBeTruthy();
    mode = "hold";
    fireEvent.click(screen.getByRole("button", { name: "刷新已记录成本" }));
    const lateRefresh = release;
    mode = "first";
    view.rerender(createElement(ProjectCostSummary, { projectId: OTHER, client }));
    fireEvent.click(screen.getByRole("button", { name: "已记录成本" }));
    expect(await screen.findByText("没有已记录的账本行。没有记录不等于免费。")).toBeTruthy();
    await act(async () => {
      lateRefresh(json(summary(PROJECT, [{ ...usdZero(), actualAmount: "9.00000000" }], 1)));
      await Promise.resolve();
    });
    expect(screen.queryByText("已记录实际金额 9.00000000")).toBeNull();
    expect(screen.getByText("没有已记录的账本行。没有记录不等于免费。")).toBeTruthy();
    mode = "hold";
    fireEvent.click(screen.getByRole("button", { name: "刷新已记录成本" }));
    const lateUnmount = release;
    view.unmount();
    await act(async () => {
      lateUnmount(json(summary(OTHER, [usdZero()], 1)));
      await Promise.resolve();
    });
    expect(document.body.textContent).not.toContain("已记录实际金额");
    expect(document.body.textContent).not.toContain("读取中断");
  });

  it("keeps the newer refresh when an older refresh returns later", async () => {
    const pending: Array<(value: Response) => void> = [];
    let calls = 0;
    const client = new StudioClient(() => {
      calls += 1;
      if (calls === 1) return Promise.resolve(json(summary(PROJECT, [usdZero()], 1)));
      return new Promise<Response>((resolve) => pending.push(resolve));
    });
    render(createElement(ProjectCostSummary, { projectId: PROJECT, client }));
    fireEvent.click(screen.getByRole("button", { name: "已记录成本" }));
    expect(await screen.findByText("已记录实际金额 0.00000000")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "刷新已记录成本" }));
    fireEvent.click(screen.getByRole("button", { name: "刷新已记录成本" }));
    expect(pending).toHaveLength(2);
    await act(async () => {
      pending[1]?.(json(summary(PROJECT, [{ ...usdZero(), actualAmount: "2.00000000" }], 1)));
      await Promise.resolve();
    });
    expect(await screen.findByText("已记录实际金额 2.00000000")).toBeTruthy();
    await act(async () => {
      pending[0]?.(json(summary(PROJECT, [{ ...usdZero(), actualAmount: "9.00000000" }], 1)));
      await Promise.resolve();
    });
    expect(screen.getByText("已记录实际金额 2.00000000")).toBeTruthy();
    expect(screen.queryByText("已记录实际金额 9.00000000")).toBeNull();
  });

  it("shows a first-load failure without a previous snapshot", async () => {
    const client = new StudioClient(() => Promise.resolve(json({ error: { code: "UNAVAILABLE", message: "账本暂时不可用" } }, 503)));
    render(createElement(ProjectCostSummary, { projectId: PROJECT, client }));
    fireEvent.click(screen.getByRole("button", { name: "已记录成本" }));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "账本暂时不可用");
    expect(screen.queryByText("包含本项目历史调用；本地编码等成本尚未计量。")).toBeNull();
  });
});

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}
