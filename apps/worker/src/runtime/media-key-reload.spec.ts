import { describe, expect, it } from "vitest";
import { mediaKeyVaultBootstrap } from "./media-key-reload";

describe("worker media key vault bootstrap", () => {
  it("stays unused only when both MODEL_ADMIN path and master key are absent", () => {
    expect(mediaKeyVaultBootstrap({})).toBeNull();
  });

  it("fails closed on a partial or malformed vault configuration", () => {
    expect(() => mediaKeyVaultBootstrap({ MODEL_ADMIN_CONFIG_PATH: "/private/models/models.enc" })).toThrow(
      "MODEL_ADMIN_MEDIA_KEY_VAULT_MISCONFIGURED",
    );
    expect(() => mediaKeyVaultBootstrap({ MODEL_ADMIN_MASTER_KEY: "a".repeat(64) })).toThrow(
      "MODEL_ADMIN_MEDIA_KEY_VAULT_MISCONFIGURED",
    );
    expect(() =>
      mediaKeyVaultBootstrap({
        MODEL_ADMIN_CONFIG_PATH: "/private/models/models.enc",
        MODEL_ADMIN_MASTER_KEY: "not-hex",
      }),
    ).toThrow("MODEL_ADMIN_MEDIA_KEY_VAULT_MISCONFIGURED");
  });

  it("opens the sibling media-keys path when both values are valid", () => {
    const bootstrap = mediaKeyVaultBootstrap({
      MODEL_ADMIN_CONFIG_PATH: "/private/models/models.enc",
      MODEL_ADMIN_MASTER_KEY: "a".repeat(64),
    });
    expect(bootstrap?.path).toBe("/private/models/media-keys.enc");
    expect(bootstrap?.masterKey).toHaveLength(32);
  });
});
