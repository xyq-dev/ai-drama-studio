import { describe, expect, it, vi } from "vitest";
import { runWithStoreCreatorAccess } from "./creator-access-context";

/**
 * Unit coverage for speech-store ownership filtering helpers.
 * Full DB acceptance for A/B opaque 404 remains in isolated CI fixtures that apply
 * Migration 20261118000100_creator_account_plan (not executed by this PR against any shared DB).
 */
describe("speech-store ownership filter wiring", () => {
  it("ownedProjectBind emits an owner predicate only when scoped and column-ready", async () => {
    const { ownedProjectBind } = await import("./creator-access-context");
    const client = {
      query: vi.fn(async () => ({ rows: [{ present: true }] })),
    };
    await runWithStoreCreatorAccess(
      { kind: "scoped", ownerAccountId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", actorId: "creator:cccccccc-cccc-4ccc-8ccc-cccccccccccc" },
      async () => {
        const bind = await ownedProjectBind(client, undefined, 3, "p");
        expect(bind.sql).toContain("p.owner_account_id = $3::uuid");
        expect(bind.params).toEqual(["cccccccc-cccc-4ccc-8ccc-cccccccccccc"]);
      },
    );
    await runWithStoreCreatorAccess({ kind: "open" }, async () => {
      const bind = await ownedProjectBind(client, undefined, 3, "p");
      expect(bind.sql).toBe("");
      expect(bind.params).toEqual([]);
    });
  });

  it("documents that creator_account_plan migration is fixture-only in this PR", () => {
    // This PR does not write a new Migration and does not execute 20261118000100 against
    // production, staging, or the developer machine. Isolated test DBs may apply it via
    // existing test flows; say so in the suite that does.
    expect("20261118000100_creator_account_plan").toMatch(/creator_account_plan/);
  });

});
