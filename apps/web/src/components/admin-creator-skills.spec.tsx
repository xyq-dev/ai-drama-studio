// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { type SkillSettingsView } from "@ai-drama/contracts";
import { AdminCreatorSkills } from "./admin-creator-skills";

afterEach(cleanup);

const initial: SkillSettingsView = {
  revision: 8, canViewRuns: true, canManage: true,
  skills: [{ id: "qc-skill", label: "成片质检", version: "1.4.5", enabled: true }],
};

it("requests a revision-checked switch and displays durable report findings", async () => {
  const client = {
    skills: vi.fn(async () => initial),
    setSkill: vi.fn(async () => ({ ...initial, revision: 9, skills: [{ ...initial.skills[0]!, enabled: false }] })),
    skillRuns: vi.fn(async () => [{
      id: "b572c5d4-3aba-4648-8738-47f4d16d245e", skill: "qc-skill" as const, version: "1.4.5",
      project: "最后一班车", at: "2026-11-24T11:00:00.000Z", status: "issues" as const, reasons: ["BLACK", "SILENCE"],
    }]),
  };
  const updated = vi.fn(async () => {});
  render(<AdminCreatorSkills client={client} onUpdated={updated} />);
  expect(client.skills).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "创作助手技能" }));
  fireEvent.click(await screen.findByRole("button", { name: "停用成片质检" }));
  expect(await screen.findByRole("button", { name: "启用成片质检" })).toBeTruthy();
  expect(client.setSkill).toHaveBeenCalledExactlyOnceWith("qc-skill", false, 8);
  await waitFor(() => expect(updated).toHaveBeenCalledOnce());
  fireEvent.click(screen.getByRole("button", { name: "查看执行记录" }));
  expect(await screen.findByText(/最后一班车.*发现问题.*黑屏、静音/)).toBeTruthy();
});

it("keeps viewer-only operators from seeing configuration or history actions", async () => {
  const client = { skills: vi.fn(async () => ({ ...initial, canManage: false, canViewRuns: false })), setSkill: vi.fn(), skillRuns: vi.fn() };
  render(<AdminCreatorSkills client={client} onUpdated={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "创作助手技能" }));
  await screen.findByText("成片质检");
  expect(screen.queryByRole("button", { name: "停用成片质检" })).toBeNull();
  expect(screen.queryByRole("button", { name: "查看执行记录" })).toBeNull();
});
