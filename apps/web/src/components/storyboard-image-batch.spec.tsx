// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { RealMediaQuote } from "@ai-drama/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StoryboardImageBatch } from "./storyboard-image-batch";
import { readRealMediaPending, type RealMediaClient } from "../lib/real-media-client";

const projectId = "11111111-1111-4111-8111-111111111111";
const shotId = "22222222-2222-4222-8222-222222222222";
const otherShot = "33333333-3333-4333-8333-333333333333";
const quoteId = "44444444-4444-4444-8444-444444444444";
const jobId = "55555555-5555-4555-8555-555555555555";
const authId = "66666666-6666-4666-8666-666666666666";
const shots = [
  { shotRevisionId: shotId, label: "第一个镜头", promptText: "雨夜木牌特写" },
  { shotRevisionId: otherShot, label: "第二个镜头", promptText: "" },
];

function fixture() {
  const quote: RealMediaQuote = {
    quoteId, inputHash: "a".repeat(64), capability: "image.generate", currency: "CNY",
    estimatedAmount: "0.25", maximumAmount: "0.25", expiresAt: "2099-01-01T00:00:00.000Z",
    providerConfigurationId: authId, providerConfigurationVersion: "1", priceVersion: "1",
    estimateBasis: "self-hosted-resource-estimate", actualCost: "unknown", singleOperation: true,
    uncertainJobIds: [jobId],
  };
  return {
    capabilities: vi.fn<RealMediaClient["capabilities"]>().mockResolvedValue({
      available: true, capabilities: [], reasonCode: null, comfyui: { status: "available", workflows: [
        { id: "text", label: "文生图", requiresReference: false, dimensions: [{ width: 512, height: 512 }] },
        { id: "reference", label: "参考图生成", requiresReference: true, dimensions: [{ width: 512, height: 512 }] },
      ] },
    }),
    quote: vi.fn<RealMediaClient["quote"]>().mockResolvedValue(quote),
    authorize: vi.fn<RealMediaClient["authorize"]>().mockResolvedValue(authId),
    generate: vi.fn<RealMediaClient["generate"]>().mockResolvedValue({ jobId, workflowRunId: authId }),
  };
}

async function confirmBatch() {
  fireEvent.click(screen.getByRole("button", { name: "批量生成图片" }));
  fireEvent.click(await screen.findByRole("button", { name: "查看批量报价" }));
  const confirm = await screen.findByRole<HTMLButtonElement>("button", { name: "确认提交 1 个镜头" });
  expect(screen.getByText("0.25 CNY", { selector: "strong" })).toBeTruthy();
  expect(screen.getByText(/请在单镜中补充合法/)).toBeTruthy();
  fireEvent.click(screen.getByLabelText(/我确认按上述额度/));
  expect(confirm.disabled).toBe(true);
  fireEvent.click(screen.getByLabelText(/我已核对列出的结果未知任务/));
  fireEvent.click(confirm);
}

describe("storyboard batch image generation", () => {
  beforeEach(() => sessionStorage.clear());
  afterEach(cleanup);

  it("quotes eligible shots individually and submits only after both confirmations", async () => {
    const client = fixture();
    render(<StoryboardImageBatch projectId={projectId} shots={shots} client={client} />);
    expect(client.generate).not.toHaveBeenCalled();
    await confirmBatch();
    expect(await screen.findByText("任务已受理")).toBeTruthy();
    expect(client.quote).toHaveBeenCalledExactlyOnceWith(projectId, shotId, "image.generate", undefined, {
      workflowId: "text", width: 512, height: 512, prompt: "雨夜木牌特写",
    });
    expect(client.authorize).toHaveBeenCalledOnce();
    expect(client.generate).toHaveBeenCalledExactlyOnceWith(projectId, shotId, quoteId, authId, client.authorize.mock.calls[0]![3]);
  });

  it("reopens an ambiguous request and sends the original identity without another authorization", async () => {
    const client = fixture();
    client.generate.mockRejectedValueOnce(new Error("lost receipt"));
    const first = render(<StoryboardImageBatch projectId={projectId} shots={shots} client={client} />);
    await confirmBatch();
    await screen.findByText(/保留原请求/);
    expect(readRealMediaPending(projectId, shotId)?.authorizationId).toBe(authId);
    first.unmount();
    render(<StoryboardImageBatch projectId={projectId} shots={shots} client={client} />);
    fireEvent.click(await screen.findByRole("button", { name: "查看上次批量结果" }));
    fireEvent.click(screen.getByRole("button", { name: "继续确认原请求" }));
    await waitFor(() => expect(screen.getByText("任务已受理")).toBeTruthy());
    expect(client.authorize).toHaveBeenCalledOnce();
    expect(client.generate.mock.calls[1]).toEqual(client.generate.mock.calls[0]);
    expect(readRealMediaPending(projectId, shotId)).toBeNull();
  });
});
