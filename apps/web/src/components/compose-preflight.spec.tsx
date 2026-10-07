// @vitest-environment happy-dom
// Simulated API. fetch is mocked; this file does not start the API, database, worker, or a real browser.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { StudioClient } from "../lib/studio-client";
import { ComposePreflight } from "./compose-preflight";

const REVISION_A = "33333333-3333-4333-8333-333333333333";
const REVISION_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const VIDEO_A = "44444444-4444-4444-8444-444444444444";
const VIDEO_B = "55555555-5555-4555-8555-555555555555";
const OLD_VIDEO = "99999999-9999-4999-8999-999999999999";
const HASH_A = "ab".repeat(32);
const HASH_B = "cd".repeat(32);

function asset(id: string, revisionId: string, kind = "VIDEO", mimeType = "video/mp4", reviewStatus = "DRAFT") {
  return {
    id,
    kind,
    mimeType,
    status: "ACTIVE",
    reviewStatus,
    sourceShotRevisionId: revisionId,
    durationMs: 1000,
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function preflightBody(hash: string) {
  return {
    manifest: {
      plan: { width: 1080, height: 1920, frameRate: 25, container: "mp4", durationMs: 1000 },
      sources: [
        { role: "video", asset: { assetId: VIDEO_A, durationMs: 1000 } },
        { role: "audio", asset: null },
        { role: "music", asset: null },
        { role: "subtitle", asset: null },
      ],
    },
    inputHash: hash,
  };
}

function deferred() {
  let resolve: (response: Response) => void = () => undefined;
  const promise = new Promise<Response>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

afterEach(() => cleanup());

describe("compose preflight selection", () => {
  it("lists only the current revision and clears a result when the selection changes", async () => {
    const calls: Array<{ url: string; headers: HeadersInit | undefined; body: string | undefined }> = [];
    const fetchImpl = (input: string, init?: RequestInit) => {
      calls.push({ url: input, headers: init?.headers, body: typeof init?.body === "string" ? init.body : undefined });
      if (input.includes("/assets")) {
        return Promise.resolve(json({
          items: [
            asset(VIDEO_A, REVISION_A),
            asset(OLD_VIDEO, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
            asset("cccccccc-cccc-4ccc-8ccc-cccccccccccc", REVISION_A, "IMAGE", "image/png"),
            asset("dddddddd-dddd-4ddd-8ddd-dddddddddddd", REVISION_A, "VIDEO", "video/mp4", "REJECTED"),
          ],
        }));
      }
      return Promise.resolve(json({
        manifest: {
          plan: { width: 1080, height: 1920, frameRate: 25, container: "mp4", durationMs: 1000 },
          sources: [
            { role: "video", asset: { assetId: VIDEO_A, durationMs: 1000 } },
            { role: "audio", asset: null },
            { role: "music", asset: null },
            { role: "subtitle", asset: null },
          ],
        },
        inputHash: HASH_A,
      }));
    };
    render(createElement(ComposePreflight, { revisionId: REVISION_A, refreshEpoch: 0, client: new StudioClient(fetchImpl) }));
    const video = await screen.findByLabelText("合成视频");
    expect(video.textContent).toContain(VIDEO_A);
    expect(video.textContent).not.toContain(OLD_VIDEO);
    expect(video.textContent).not.toContain("cccccccc-cccc-4ccc-8ccc-cccccccccccc");
    expect(video.textContent).not.toContain("dddddddd-dddd-4ddd-8ddd-dddddddddddd");
    expect(screen.getByLabelText("合成配音").textContent).toContain("未选择");
    expect(screen.getByRole("button", { name: "开始合成" }).hasAttribute("disabled")).toBe(true);
    fireEvent.change(video, { target: { value: VIDEO_A } });
    fireEvent.click(screen.getByRole("button", { name: "预检合成输入" }));
    expect(await screen.findByText("合成尚未执行")).toBeTruthy();
    expect(screen.getByText(/1080×1920/)).toBeTruthy();
    expect(screen.getByText(/1000 ms/)).toBeTruthy();
    expect(screen.queryByText("已受理")).toBeNull();
    expect(screen.queryByText("生成成功")).toBeNull();
    const post = calls.find((call) => call.url.includes("compose-preflight"));
    expect(post?.headers).toMatchObject({ "Content-Type": "application/json" });
    expect(JSON.stringify(post?.headers)).not.toContain("Idempotency-Key");
    expect(screen.getByRole("button", { name: "开始合成" }).hasAttribute("disabled")).toBe(false);
    fireEvent.change(screen.getByLabelText("合成音乐"), { target: { value: "" } });
    expect(screen.getByRole("button", { name: "开始合成" }).hasAttribute("disabled")).toBe(true);
    expect(screen.queryByText("合成尚未执行")).toBeNull();
    expect(screen.queryByText(HASH_A)).toBeNull();
  });

  it("ignores a late response after A to B to A and after a selection change", async () => {
    const first = deferred();
    const second = deferred();
    let posts = 0;
    const fetchImpl = (input: string) => {
      if (input.includes("/assets")) {
        const revisionId = input.includes(REVISION_B) ? REVISION_B : REVISION_A;
        const videoId = revisionId === REVISION_B ? VIDEO_B : VIDEO_A;
        return Promise.resolve(json({ items: [asset(videoId, revisionId), asset(VIDEO_B, REVISION_A)] }));
      }
      posts += 1;
      const pending = posts === 1 ? first : second;
      return pending.promise;
    };
    const view = render(createElement(ComposePreflight, { revisionId: REVISION_A, refreshEpoch: 0, client: new StudioClient(fetchImpl) }));
    fireEvent.change(await screen.findByLabelText("合成视频"), { target: { value: VIDEO_A } });
    fireEvent.click(screen.getByRole("button", { name: "预检合成输入" }));
    view.rerender(createElement(ComposePreflight, { revisionId: REVISION_B, refreshEpoch: 0, client: new StudioClient(fetchImpl) }));
    view.rerender(createElement(ComposePreflight, { revisionId: REVISION_A, refreshEpoch: 0, client: new StudioClient(fetchImpl) }));
    first.resolve(json({
      manifest: { plan: { width: 1080, height: 1920, frameRate: 25, container: "mp4", durationMs: 1000 }, sources: [] },
      inputHash: HASH_A,
    }));
    await waitFor(() => expect(screen.queryByText(HASH_A)).toBeNull());
    expect(screen.queryByText("合成尚未执行")).toBeNull();

    fireEvent.change(await screen.findByLabelText("合成视频"), { target: { value: VIDEO_A } });
    fireEvent.click(screen.getByRole("button", { name: "预检合成输入" }));
    fireEvent.change(screen.getByLabelText("合成视频"), { target: { value: VIDEO_B } });
    fireEvent.change(screen.getByLabelText("合成视频"), { target: { value: VIDEO_A } });
    second.resolve(json({
      manifest: { plan: { width: 1080, height: 1920, frameRate: 25, container: "mp4", durationMs: 1000 }, sources: [] },
      inputHash: HASH_B,
    }));
    await waitFor(() => expect(screen.queryByText(HASH_B)).toBeNull());
    expect(screen.queryByText("合成尚未执行")).toBeNull();
  });

  it("clears the previous result while a retry is waiting, shows only that error, and retries", async () => {
    const rejected = deferred();
    const retried = deferred();
    let posts = 0;
    const fetchImpl = (input: string) => {
      if (input.includes("/assets")) return Promise.resolve(json({ items: [asset(VIDEO_A, REVISION_A)] }));
      posts += 1;
      if (posts === 1) return Promise.resolve(json(preflightBody(HASH_A)));
      if (posts === 2) return rejected.promise;
      return retried.promise;
    };
    render(createElement(ComposePreflight, { revisionId: REVISION_A, refreshEpoch: 0, client: new StudioClient(fetchImpl) }));
    fireEvent.change(await screen.findByLabelText("合成视频"), { target: { value: VIDEO_A } });
    fireEvent.click(screen.getByRole("button", { name: "预检合成输入" }));
    expect(await screen.findByText(HASH_A)).toBeTruthy();
    expect(screen.getByText("合成尚未执行")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "预检合成输入" }));
    expect(screen.queryByText(HASH_A)).toBeNull();
    expect(screen.queryByText("合成尚未执行")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect((screen.getByLabelText("合成视频") as HTMLSelectElement).value).toBe(VIDEO_A);

    rejected.resolve(json({ error: { code: "COMPOSE_INPUT_INVALID", message: "本次预检没有通过" } }, 400));
    expect(await screen.findByText("本次预检没有通过")).toBeTruthy();
    expect(screen.queryByText(HASH_A)).toBeNull();
    expect(screen.queryByText("合成尚未执行")).toBeNull();
    expect((screen.getByLabelText("合成视频") as HTMLSelectElement).value).toBe(VIDEO_A);

    fireEvent.click(screen.getByRole("button", { name: "预检合成输入" }));
    expect(screen.queryByText("本次预检没有通过")).toBeNull();
    expect(screen.queryByText(HASH_A)).toBeNull();
    expect((screen.getByLabelText("合成视频") as HTMLSelectElement).value).toBe(VIDEO_A);
    retried.resolve(json(preflightBody(HASH_B)));
    expect(await screen.findByText(HASH_B)).toBeTruthy();
    expect(screen.getByText("合成尚未执行")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    expect((screen.getByLabelText("合成视频") as HTMLSelectElement).value).toBe(VIDEO_A);
  });

  it("keeps a newer result when an older response arrives", async () => {
    const older = deferred();
    const newer = deferred();
    let posts = 0;
    const fetchImpl = (input: string) => {
      if (input.includes("/assets")) return Promise.resolve(json({ items: [asset(VIDEO_A, REVISION_A), asset(VIDEO_B, REVISION_A)] }));
      posts += 1;
      return posts === 1 ? older.promise : newer.promise;
    };
    render(createElement(ComposePreflight, { revisionId: REVISION_A, refreshEpoch: 0, client: new StudioClient(fetchImpl) }));
    fireEvent.change(await screen.findByLabelText("合成视频"), { target: { value: VIDEO_A } });
    fireEvent.click(screen.getByRole("button", { name: "预检合成输入" }));
    fireEvent.change(screen.getByLabelText("合成视频"), { target: { value: VIDEO_B } });
    fireEvent.change(screen.getByLabelText("合成视频"), { target: { value: VIDEO_A } });
    fireEvent.click(screen.getByRole("button", { name: "预检合成输入" }));
    newer.resolve(json(preflightBody(HASH_B)));
    expect(await screen.findByText(HASH_B)).toBeTruthy();
    older.resolve(json({ error: { code: "COMPOSE_INPUT_INVALID", message: "旧预检失败" } }, 400));
    await waitFor(() => expect(screen.queryByText("旧预检失败")).toBeNull());
    expect(screen.getByText(HASH_B)).toBeTruthy();
    expect(screen.getByText("合成尚未执行")).toBeTruthy();
    expect((screen.getByLabelText("合成视频") as HTMLSelectElement).value).toBe(VIDEO_A);
  });

  it("clears the result when a selected asset becomes unusable", async () => {
    let items = [asset(VIDEO_A, REVISION_A)];
    const fetchImpl = (input: string) => {
      if (input.includes("/assets")) return Promise.resolve(json({ items }));
      return Promise.resolve(json(preflightBody(HASH_A)));
    };
    const client = new StudioClient(fetchImpl);
    const view = render(createElement(ComposePreflight, { revisionId: REVISION_A, refreshEpoch: 0, client }));
    fireEvent.change(await screen.findByLabelText("合成视频"), { target: { value: VIDEO_A } });
    fireEvent.click(screen.getByRole("button", { name: "预检合成输入" }));
    expect(await screen.findByText(HASH_A)).toBeTruthy();
    items = [asset(VIDEO_A, REVISION_A, "VIDEO", "video/mp4", "REJECTED")];
    view.rerender(createElement(ComposePreflight, { revisionId: REVISION_A, refreshEpoch: 1, client }));
    await waitFor(() => expect(screen.queryByText(HASH_A)).toBeNull());
    expect(screen.queryByText("合成尚未执行")).toBeNull();
    expect((screen.getByLabelText("合成视频") as HTMLSelectElement).value).toBe("");
  });
});

describe("compose preflight closed by the capability gate (PR #53 review 3)", () => {
  it("keeps preflight and submit closed while blocked, still lists existing cuts, and keeps the selection when opened", async () => {
    const posts: string[] = [];
    const composite = { ...asset("eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", REVISION_A, "COMPOSITE", "video/mp4", "APPROVED"), rowVersion: 2, checksumSha256: HASH_A };
    const fetchImpl = (input: string, init?: RequestInit) => {
      if (init?.method === "POST") posts.push(input);
      if (input.includes("/assets")) return Promise.resolve(json({ items: [asset(VIDEO_A, REVISION_A), composite] }));
      return Promise.resolve(json(preflightBody(HASH_A)));
    };
    const client = new StudioClient(fetchImpl);
    const view = render(createElement(ComposePreflight, { revisionId: REVISION_A, refreshEpoch: 0, client, blocked: "正在检查单镜合成是否开启，检查完成前不能开始新的合成。" }));
    await waitFor(() => expect(screen.getByRole("option", { name: VIDEO_A })).toBeTruthy());
    fireEvent.change(screen.getByLabelText("合成视频"), { target: { value: VIDEO_A } });
    expect(screen.getByText(/检查完成前不能开始新的合成/)).toBeTruthy();
    const preflight = screen.getByRole("button", { name: "预检合成输入" }) as HTMLButtonElement;
    expect(preflight.disabled).toBe(true);
    fireEvent.click(preflight);
    expect((screen.getByRole("button", { name: "开始合成" }) as HTMLButtonElement).disabled).toBe(true);
    expect(posts).toEqual([]);
    // The approved cut made earlier is still shown.
    await waitFor(() => expect(document.querySelector(`[data-composite-id="${composite.id}"]`)).toBeTruthy());
    view.rerender(createElement(ComposePreflight, { revisionId: REVISION_A, refreshEpoch: 0, client, blocked: null }));
    expect((screen.getByLabelText("合成视频") as HTMLSelectElement).value).toBe(VIDEO_A);
    expect((screen.getByRole("button", { name: "预检合成输入" }) as HTMLButtonElement).disabled).toBe(false);
  });
});
