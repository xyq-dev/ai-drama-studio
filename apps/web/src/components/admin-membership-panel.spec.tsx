// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { AdminMembershipPanel } from "./admin-membership-panel";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("keeps each feature and its independent quota in one labelled row when editing a plan", async () => {
  const plan = {
    id: "plan",
    name: "基础",
    code: "basic",
    features: [{ feature: "writing", enabled: true, includedUnits: 3 }],
  };
  const request = vi.fn(async (url: string) =>
    Response.json({ items: url.endsWith("/plans") ? [plan] : [] }),
  );
  vi.stubGlobal("fetch", request);
  render(<AdminMembershipPanel />);
  fireEvent.click(await screen.findByRole("button", { name: "编辑基础" }));
  const card = within(screen.getByRole("form", { name: "套餐" }));
  const group = within(card.getByRole("group", { name: "功能与每月额度" }));
  for (const label of ["编剧", "生图", "配音", "视频"]) {
    const toggle = group.getByRole("checkbox", { name: label });
    const input = group.getByRole("textbox", { name: label + "额度" }) as HTMLInputElement;
    expect(toggle.closest("label")!.parentElement).toBe(input.parentElement);
    expect(input.disabled).toBe(label !== "编剧");
  }
  expect((group.getByRole("textbox", { name: "编剧额度" }) as HTMLInputElement).value).toBe("3");
  fireEvent.click(group.getByRole("checkbox", { name: "配音" }));
  fireEvent.change(group.getByRole("textbox", { name: "配音额度" }), { target: { value: "5" } });
  fireEvent.click(card.getByRole("button", { name: "保存套餐" }));
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith(
      "/api/v1/admin/membership/plans",
      expect.objectContaining({
        method: "PUT",
        body: expect.stringContaining('"voice":{"enabled":true,"includedUnits":"5"}'),
      }),
    ),
  );
  expect(screen.getByRole("form", { name: "手动开通" })).toBeTruthy();
  expect(screen.getByRole("form", { name: "调整额度" })).toBeTruthy();
});
