import { describe, expect, it } from "vitest";
import {
  addCalendarMonths,
  creatorAccountIdFromActor,
  decideReserve,
  membershipDenialMessage,
} from "./creator-membership";

const window = { status: "active" as const, startsAt: 0, endsAt: 100 };

describe("creator membership decisions", () => {
  it("names the reason before a provider would be called", () => {
    expect(membershipDenialMessage("MEMBERSHIP_REQUIRED", "writing")).toContain("还没有开通会员");
    expect(membershipDenialMessage("MEMBERSHIP_EXPIRED", "writing")).toContain("已完成的作品仍可查看");
    expect(membershipDenialMessage("FEATURE_NOT_INCLUDED", "image")).toContain("生图");
    expect(membershipDenialMessage("QUOTA_EXHAUSTED", "voice")).toContain("配音额度已用完");
  });

  it("replays one hold and denies when the window or quota cannot cover a new task", () => {
    expect(decideReserve({
      now: 10, membership: null, featureEnabled: true, remaining: 0, units: 1, existing: null,
    })).toEqual({ action: "deny", code: "MEMBERSHIP_REQUIRED" });
    expect(decideReserve({
      now: 100, membership: window, featureEnabled: true, remaining: 3, units: 1, existing: null,
    })).toEqual({ action: "deny", code: "MEMBERSHIP_EXPIRED" });
    expect(decideReserve({
      now: 10, membership: { ...window, status: "disabled" }, featureEnabled: true, remaining: 3, units: 1, existing: null,
    })).toEqual({ action: "deny", code: "MEMBERSHIP_DISABLED" });
    expect(decideReserve({
      now: 10, membership: window, featureEnabled: false, remaining: 3, units: 1, existing: null,
    })).toEqual({ action: "deny", code: "FEATURE_NOT_INCLUDED" });
    expect(decideReserve({
      now: 10, membership: window, featureEnabled: true, remaining: 0, units: 1, existing: null,
    })).toEqual({ action: "deny", code: "QUOTA_EXHAUSTED" });
    expect(decideReserve({
      now: 10, membership: window, featureEnabled: true, remaining: 1, units: 1, existing: null,
    })).toEqual({ action: "hold" });
    expect(decideReserve({
      now: 10, membership: null, featureEnabled: false, remaining: 0, units: 1, existing: { status: "held" },
    })).toEqual({ action: "replay" });
    expect(decideReserve({
      now: 10, membership: null, featureEnabled: false, remaining: 0, units: 1, existing: { status: "unknown" },
    })).toEqual({ action: "replay" });
    expect(decideReserve({
      now: 10, membership: window, featureEnabled: true, remaining: 2, units: 1, existing: { status: "released" },
    })).toEqual({ action: "rehold" });
  });

  it("adds calendar months without inventing a price", () => {
    expect(addCalendarMonths(new Date("2026-01-31T00:00:00.000Z"), 1).toISOString()).toBe("2026-02-28T00:00:00.000Z");
    expect(creatorAccountIdFromActor("server-owner")).toBeNull();
    expect(creatorAccountIdFromActor("creator:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")).toBe(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    );
  });
});
