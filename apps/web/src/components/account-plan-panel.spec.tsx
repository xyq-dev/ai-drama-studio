// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccountPlanPanel } from "./account-plan-panel";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("account plan panel (phase 4)", () => {
  it("shows 尚未计价 for unpriced unit price and remaining quota", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.includes("/account/plan")) {
        return json({
          accountId: "acct",
          planName: "默认用量计划",
          unitPriceLabel: "尚未计价",
          remainingLabel: "余量 尚未计价",
          entitlementStatus: "unpriced",
          unitPriceAmount: null,
          remainingUnits: null,
        });
      }
      return json({ items: [] });
    }));
    render(<AccountPlanPanel />);
    await waitFor(() => expect(screen.getByTestId("account-plan-unit-price").textContent).toContain("尚未计价"));
    expect(screen.getByTestId("account-plan-remaining").textContent).toContain("尚未计价");
    expect(screen.getByTestId("account-ledger-empty").textContent).toContain("未确认的点击不会写入账本");
  });
});
