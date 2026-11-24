// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CreatorSkillAssistant } from "./creator-skill-assistant";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const props = { projectId: "project", episodeId: "episode-2", episodeNo: 2, stage: "script" as const, textOnly: false };
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("creator skill assistant", () => {
  it("preserves an ambiguous instruction and passes the chosen operation to the same episode", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(response({ skill: null, instruction: "这里再改一下" }))
      .mockResolvedValueOnce(response({ skill: "short-drama-write", instruction: "这里再改一下" }));
    vi.stubGlobal("fetch", fetch);
    const onResolved = vi.fn();
    render(<CreatorSkillAssistant {...props} onResolved={onResolved} />);
    const input = screen.getByLabelText("想让助手做什么？") as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "这里再改一下" } });
    fireEvent.click(screen.getByRole("button", { name: "使用助手" }));
    await screen.findByText("请选择要执行的操作。");
    expect(onResolved).not.toHaveBeenCalled();
    expect(input.value).toBe("这里再改一下");
    fireEvent.click(screen.getByRole("button", { name: "编写或修改剧本" }));
    await waitFor(() => expect(onResolved).toHaveBeenCalledOnce());
    const [url, req] = fetch.mock.calls[1]!;
    expect(url).toBe("/api/v1/projects/project/assistant/resolve");
    expect(JSON.parse(req.body)).toEqual({ stage: "script", episodeNo: 2, command: "这里再改一下", skill: "short-drama-write" });
    expect(onResolved.mock.calls[0]![0]).toMatchObject({ projectId: "project", episodeId: "episode-2", skill: "short-drama-write", instruction: "这里再改一下" });
  });

  it("explains a disabled tool, preserves the command and keeps the creator on this episode", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({ error: { code: "CREATOR_SKILL_DISABLED", message: "短剧编剧技能已停用。" } }, 409)));
    const onResolved = vi.fn();
    render(<CreatorSkillAssistant {...props} onResolved={onResolved} />);
    const input = screen.getByLabelText("想让助手做什么？") as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "修改对白" } });
    fireEvent.click(screen.getByRole("button", { name: "使用助手" }));
    await screen.findByText("短剧编剧技能已停用。");
    expect(input.value).toBe("修改对白");
    expect(onResolved).not.toHaveBeenCalled();
  });

  it("discards a delayed response after changing episode and limits text-only series to writing", async () => {
    let finish!: (value: Response) => void;
    vi.stubGlobal("fetch", vi.fn().mockImplementation(() => new Promise<Response>(resolve => { finish = resolve; })));
    const onResolved = vi.fn();
    const view = render(<CreatorSkillAssistant key="episode-2" {...props} onResolved={onResolved} />);
    fireEvent.click(screen.getByRole("button", { name: "查看成片质检" }));
    view.rerender(<CreatorSkillAssistant key="episode-3" {...props} episodeId="episode-3" episodeNo={3} textOnly onResolved={onResolved} />);
    expect(screen.queryByRole("button", { name: "查看成片质检" })).toBeNull();
    expect(screen.queryByRole("button", { name: "拆分场景镜头" })).toBeNull();
    await act(async () => { finish(response({ skill: "qc-skill", instruction: "查看成片质检" })); });
    expect(onResolved).not.toHaveBeenCalled();
  });
});
