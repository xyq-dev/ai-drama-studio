import { describe, expect, it } from "vitest";
import type { IdempotencyScope } from "@ai-drama/database";
import { StudioService } from "./studio.service";

/**
 * The identity of a shot write is its idempotency request hash. A shot request recorded before planned durations
 * existed must keep matching its replay, so a client whose response was lost can still recover the original receipt.
 *
 * LEGACY_HASH was produced by the released code (main at f5e8eb491ed2584ae708056a6448daf23358d5ec): its
 * StudioService.createShotRevision, run with the same stubs and the BODY below, hashed exactly this value. That code had
 * no plannedDurationMs field and stripped it from any body, so every legacy record has this shape.
 */
const LEGACY_HASH = "ff253f3642381317614e3a1a45ef72c58835de9a3e9c0fb0635e5d607d868ee9";
const BODY = { sourceSceneRevisionId: "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA", ordinal: 2, shotType: "中景", camera: "固定机位",
  action: "林夏停下", dialogue: "林夏：这不是我。", promptText: "便利店；中景" };

async function write(body: unknown): Promise<{ scope: IdempotencyScope; persisted: Record<string, unknown> }> {
  let scope: IdempotencyScope | null = null;
  let persisted: Record<string, unknown> | null = null;
  const jobs = {
    runIdempotent: async (given: IdempotencyScope, status: number, operation: (client: unknown) => Promise<unknown>) => {
      scope = given;
      return { replayed: false, status, body: await operation({}) };
    },
  };
  const chain = {
    listSceneRevisions: async () => [],
    listShotRevisions: async () => [],
    createShotScopedInTransaction: async (_client: unknown, input: Record<string, unknown>) => { persisted = input; return {}; },
  };
  const service = new StudioService(jobs as never, { getProject: async () => ({}) } as never, chain as never, "11111111-1111-4111-8111-111111111111");
  await service.createShotRevision("22222222-2222-4222-8222-222222222222", "33333333-3333-4333-8333-333333333333",
    "44444444-4444-4444-8444-444444444444", undefined, body, "3", { actorId: "server-owner", traceId: "t", idempotencyKey: "k" });
  return { scope: scope!, persisted: persisted! };
}

describe("shot write identity across the planned duration field", () => {
  it("keeps the released hash for a request without a planned duration, and an explicit null means the same", async () => {
    const omitted = await write(BODY);
    expect(omitted.scope.requestHash).toBe(LEGACY_HASH);
    expect(omitted.persisted.plannedDurationMs).toBeNull();
    const explicitNull = await write({ ...BODY, plannedDurationMs: null });
    expect(explicitNull.scope.requestHash).toBe(LEGACY_HASH);
    expect(explicitNull.persisted.plannedDurationMs).toBeNull();
  });

  it("gives a planned duration, a changed duration and changed content their own identity", async () => {
    const four = await write({ ...BODY, plannedDurationMs: 4000 });
    const five = await write({ ...BODY, plannedDurationMs: 5000 });
    expect(four.persisted.plannedDurationMs).toBe(4000);
    expect(new Set([LEGACY_HASH, four.scope.requestHash, five.scope.requestHash]).size).toBe(3);
    expect((await write({ ...BODY, action: "林夏转身" })).scope.requestHash).not.toBe(LEGACY_HASH);
    expect((await write({ ...BODY, action: "林夏转身", plannedDurationMs: 4000 })).scope.requestHash).not.toBe(four.scope.requestHash);
  });
});
