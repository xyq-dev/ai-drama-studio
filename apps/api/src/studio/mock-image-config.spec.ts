import { expect, it } from "vitest";
import type { JobPersistenceService, RuntimeStore, TextChainService } from "@ai-drama/database";
import { StudioService } from "./studio.service";

it("fails closed when Mock image worker storage is not explicitly enabled", async () => {
  const service = new StudioService(
    {} as JobPersistenceService, {} as RuntimeStore, {} as TextChainService,
    "11111111-1111-4111-8111-111111111111",
  );
  await expect(service.generateShotImage("22222222-2222-4222-8222-222222222222", {}, {
    actorId: "owner", traceId: "test", idempotencyKey: "key",
  })).rejects.toMatchObject({ code: "CONFIGURATION_ERROR" });
});
