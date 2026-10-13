import { describe, expect, it } from "vitest";
import { MediaAssetStore } from "@ai-drama/database";
import { StudioService } from "./studio.service";

/**
 * GET /providers/capabilities reports whether local composition is switched on, by the same conditions the compose
 * routes check, so a reader can show a closed feature instead of offering an action the server will reject.
 */
function service(flags: { mediaAssets?: boolean; av?: boolean; local?: boolean; episode?: boolean }) {
  return new StudioService(
    {} as never,
    {} as never,
    {} as never,
    "11111111-1111-4111-8111-111111111111",
    undefined,
    flags.mediaAssets === false ? undefined : ({} as unknown as MediaAssetStore),
    false,
    null,
    flags.av ?? false,
    false,
    flags.local ?? false,
    "/should/never/leak",
    flags.episode ?? false,
  );
}

describe("capabilities compose switches", () => {
  it("are closed by default", () => {
    expect(service({}).capabilities().compose).toEqual({ shot: false, episode: false });
  });

  it("open single-shot compose only when local compose and Mock audio/video are both on", () => {
    expect(service({ local: true }).capabilities().compose.shot).toBe(false);
    expect(service({ av: true }).capabilities().compose.shot).toBe(false);
    expect(service({ local: true, av: true }).capabilities().compose.shot).toBe(true);
    expect(service({ local: true, av: true, mediaAssets: false }).capabilities().compose.shot).toBe(false);
  });

  it("open episode compose with its own switch", () => {
    expect(service({ episode: true }).capabilities().compose).toEqual({ shot: false, episode: true });
    expect(service({ episode: true, mediaAssets: false }).capabilities().compose.episode).toBe(false);
  });

  it("carry booleans only: no directory, path or credential", () => {
    const body = JSON.stringify(service({ local: true, av: true, episode: true }).capabilities());
    expect(body).not.toContain("/should/never/leak");
    expect(Object.values(service({ local: true, av: true, episode: true }).capabilities().compose)
      .every((value) => typeof value === "boolean")).toBe(true);
  });
});
