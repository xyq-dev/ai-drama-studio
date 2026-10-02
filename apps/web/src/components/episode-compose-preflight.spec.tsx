// @vitest-environment happy-dom
// Simulated API. fetch is mocked; this file does not start the API, database, worker, or a real browser.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { StudioClient } from "../lib/studio-client";
import { EpisodeComposePreflight } from "./episode-compose-preflight";

const PROJECT = "22222222-2222-4222-8222-222222222222";
const EPISODE_A = "33333333-3333-4333-8333-333333333333";
const EPISODE_B = "34343434-3434-4434-8434-343434343434";
const ASSET_A = "44444444-4444-4444-8444-444444444441";
const ASSET_B = "44444444-4444-4444-8444-444444444442";
const SHOT_A = "55555555-5555-4555-8555-555555555551";
const SHOT_B = "55555555-5555-4555-8555-555555555552";
const HASH_A = "ab".repeat(32);

function candidate(assetId: string, shotId: string) {
  return {
    assetId,
    shotId,
    shotRevisionId: "66666666-6666-4666-8666-666666666661",
    sceneId: "99999999-9999-4999-8999-999999999999",
    sceneOrdinal: assetId === ASSET_A ? 1 : 2,
    sceneHeading: assetId === ASSET_A ? "INT. ROOM" : "INT. HALL",
    shotOrdinal: 1,
    durationMs: 1000,
    reviewStatus: "APPROVED",
  };
}

function preflight(hash: string, first = ASSET_A, second = ASSET_B) {
  return {
    verification: "metadata",
    diskContentChecked: false,
    decoded: false,
    executed: false,
    statusNote: "预检通过，尚未执行多镜合成",
    durationNotice: "尚未达到 V1 的 60–90 秒目标",
    inputHash: hash,
    manifest: {
      plan: { durationMs: 2000, width: 1080, height: 1920, frameRate: 25, container: "mp4" },
      segments: [
        { position: 1, assetId: first, startMs: 0, endMs: 1000, durationMs: 1000 },
        { position: 2, assetId: second, startMs: 1000, endMs: 2000, durationMs: 1000 },
      ],
    },
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function deferred() {
  let resolve: (response: Response) => void = () => undefined;
  const promise = new Promise<Response>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function selectedIds() {
  return [...document.querySelectorAll("[data-selected-asset-id]")].map((node) => node.getAttribute("data-selected-asset-id"));
}

afterEach(() => cleanup());

describe("episode compose arrangement", () => {
  it("clears the previous hash when the order changes and keeps the selection after a failure", async () => {
    const calls: string[] = [];
    const fetchImpl = (input: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? "GET"} ${input}`);
      if (!init || init.method === "GET") {
        return Promise.resolve(json({
          items: [candidate(ASSET_A, SHOT_A), candidate(ASSET_B, SHOT_B)],
          nextCursor: null,
        }));
      }
      const body = typeof init.body === "string" ? init.body : "";
      if (body.indexOf(ASSET_B) !== -1 && body.indexOf(ASSET_B) < body.indexOf(ASSET_A)) {
        return Promise.resolve(json({ error: { code: "COMPOSE_INPUT_INVALID", message: "来源已失效" } }, 400));
      }
      return Promise.resolve(json(preflight(HASH_A)));
    };
    render(createElement(EpisodeComposePreflight, {
      projectId: PROJECT,
      episodeId: EPISODE_A,
      episodeNo: 1,
      client: new StudioClient(fetchImpl),
    }));
    await screen.findByText("场景 1 INT. ROOM");
    const addButtons = screen.getAllByRole("button", { name: "加入" });
    fireEvent.click(addButtons[0]!);
    fireEvent.click(addButtons[1]!);
    fireEvent.click(screen.getByRole("button", { name: "预检编排" }));
    await screen.findByText("预检通过，尚未执行多镜合成");
    expect(screen.getByText(`inputHash ${HASH_A}`)).toBeTruthy();
    const second = document.querySelector(`[data-selected-asset-id="${ASSET_B}"]`);
    fireEvent.click(second?.querySelector("button") as HTMLButtonElement);
    await waitFor(() => expect(screen.queryByText(`inputHash ${HASH_A}`)).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "预检编排" }));
    await screen.findByRole("alert");
    expect(screen.getByRole("alert").textContent).toContain("来源已失效");
    expect(selectedIds()).toEqual([ASSET_B, ASSET_A]);
    expect(calls.filter((call) => call.startsWith("POST")).every((call) => call.includes("compose-preflight"))).toBe(true);
  });

  it("drops a late preflight when the episode goes from A to B and back to A", async () => {
    const pending = deferred();
    const fetchImpl = (input: string, init?: RequestInit) => {
      if (!init || init.method === "GET") {
        if (input.includes(EPISODE_B)) {
          return Promise.resolve(json({ items: [candidate(ASSET_B, SHOT_B)], nextCursor: null }));
        }
        return Promise.resolve(json({
          items: [candidate(ASSET_A, SHOT_A), candidate(ASSET_B, SHOT_B)],
          nextCursor: null,
        }));
      }
      return pending.promise;
    };
    const client = new StudioClient(fetchImpl);
    const view = render(createElement(EpisodeComposePreflight, {
      projectId: PROJECT,
      episodeId: EPISODE_A,
      episodeNo: 1,
      client,
    }));
    await screen.findByText("场景 1 INT. ROOM");
    const addButtons = screen.getAllByRole("button", { name: "加入" });
    fireEvent.click(addButtons[0]!);
    fireEvent.click(addButtons[1]!);
    fireEvent.click(screen.getByRole("button", { name: "预检编排" }));
    view.rerender(createElement(EpisodeComposePreflight, {
      projectId: PROJECT,
      episodeId: EPISODE_B,
      episodeNo: 2,
      client,
    }));
    await screen.findByText("场景 2 INT. HALL");
    expect(screen.queryByText(`inputHash ${HASH_A}`)).toBeNull();
    view.rerender(createElement(EpisodeComposePreflight, {
      projectId: PROJECT,
      episodeId: EPISODE_A,
      episodeNo: 1,
      client,
    }));
    pending.resolve(json(preflight(HASH_A)));
    await waitFor(() => expect(selectedIds()).toEqual([ASSET_A, ASSET_B]));
    expect(screen.queryByText(`inputHash ${HASH_A}`)).toBeNull();
    expect(screen.queryByText("预检通过，尚未执行多镜合成")).toBeNull();
  });

  it("retries a failed candidate load with a read", async () => {
    let opened = false;
    const calls: string[] = [];
    const fetchImpl = (input: string, init?: RequestInit) => {
      calls.push(init?.method ?? "GET");
      if (!opened) {
        return Promise.resolve(json({ error: { code: "NOT_FOUND", message: "候选成片加载失败" } }, 500));
      }
      return Promise.resolve(json({
        items: [candidate(ASSET_A, SHOT_A), candidate(ASSET_B, SHOT_B)],
        nextCursor: "next",
      }));
    };
    render(createElement(EpisodeComposePreflight, {
      projectId: PROJECT,
      episodeId: EPISODE_A,
      episodeNo: 1,
      client: new StudioClient(fetchImpl),
    }));
    await screen.findByRole("alert");
    opened = true;
    fireEvent.click(screen.getByRole("button", { name: "重新查询" }));
    await screen.findByText("场景 1 INT. ROOM");
    expect(calls.every((method) => method === "GET")).toBe(true);
    expect(screen.getByRole("button", { name: "加载更多" })).toBeTruthy();
  });
});
