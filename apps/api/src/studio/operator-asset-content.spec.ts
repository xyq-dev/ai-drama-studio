import { expect, it, vi } from "vitest";
import { PersistenceError } from "@ai-drama/database";
import { StudioService } from "./studio.service";

const WORKSPACE = "11111111-1111-4111-8111-111111111111";
const ASSET = "33333333-3333-4333-8333-333333333333";

function service(storageProvider: string) {
  const getWorkspaceAsset = vi.fn(async () => ({ storageProvider }));
  const studio = new StudioService(
    {} as never,
    {} as never,
    {} as never,
    WORKSPACE,
    undefined,
    { getWorkspaceAsset } as never,
  );
  return { studio, getWorkspaceAsset };
}

it("sends s3 assets to the real-media reader and leaves mock assets on the mock reader", async () => {
  const real = service("s3");
  const readReal = vi.fn(async () => ({ mimeType: "image/png", bytes: Buffer.from("png") }));
  await expect(real.studio.readOperatorAssetContent(ASSET, readReal)).resolves.toMatchObject({ mimeType: "image/png" });
  expect(readReal).toHaveBeenCalledWith(ASSET);

  const missing = service("s3");
  await expect(missing.studio.readOperatorAssetContent(ASSET, null)).rejects.toMatchObject({ code: "REAL_MEDIA_NOT_READY" });

  const mock = service("mock-object-store");
  const unused = vi.fn();
  await expect(mock.studio.readOperatorAssetContent(ASSET, unused)).rejects.toBeInstanceOf(PersistenceError);
  expect(unused).not.toHaveBeenCalled();
});
