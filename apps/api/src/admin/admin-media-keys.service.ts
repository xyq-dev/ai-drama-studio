import {
  MEDIA_KEY_SLOT_HINTS,
  MEDIA_KEY_SLOT_LABELS,
  MEDIA_KEY_SLOTS,
  type AdminMediaKeySlotView,
  type AdminMediaKeyUpdate,
  type AdminMediaKeysView,
  type MediaKeyServiceState,
  type MediaKeySlot,
} from "@ai-drama/contracts";
import {
  MediaKeyVault,
  applyManagedMediaKeys,
  mediaKeyPresent,
  mediaKeyVaultPath,
  type ManagedMediaKeys,
  type RealMediaEnvironment,
  type ServerRealMediaRuntime,
} from "@ai-drama/providers";
import type { AdminBootstrap } from "./admin-bootstrap";
import { AdminHttpError } from "./admin-auth";

const NOTICES = [
  "填写密钥不等于自动发起付费生成；正式出图、配音、成片仍须先报价并经用户确认。",
  "单价仍可空即「尚未计价」；填写密钥不会锁定或承诺售价，也不会接入支付或开启公开自助注册。",
  "不得把写作 OPENAI_API_KEY、ELEVENLABS_TTS_API_KEY、百炼 TTS 或其他非对应密钥当成上述槽位的替补。",
  "保存只做本地格式校验，不会调用真实供应商，也不会产生费用。",
  "「密钥已保存」不等于「服务可用」。请先配置单价后再启用对应能力。",
];

const POSITIVE_AMOUNT = /^(0|[1-9]\d{0,7})(\.\d{1,8})?$/;

/** Local-only price readiness from process/env snapshots. Never calls vendors. */
export function mediaKeyPriceConfigured(slot: MediaKeySlot, env: RealMediaEnvironment): boolean {
  if (!env.REAL_MEDIA_PRICE_VERSION) return false;
  const positive = (value: string | undefined): boolean =>
    Boolean(value && POSITIVE_AMOUNT.test(value) && Number(value) > 0);
  if (slot === "OPENAI_MEDIA_API_KEY") return positive(env.OPENAI_MEDIA_PRICE_IMAGE);
  if (slot === "DASHSCOPE_MEDIA_API_KEY") {
    return positive(env.DASHSCOPE_MEDIA_PRICE_IMAGE) || positive(env.DASHSCOPE_MEDIA_PRICE_VIDEO_SECOND);
  }
  return positive(env.MINIMAX_TTS_PRICE_CHARACTER);
}

export function mediaKeyServiceState(input: {
  keyConfigured: boolean;
  priceConfigured: boolean;
  /** Optional overlay: a one-off generation failed while the service remains available. */
  singleFailure?: boolean;
}): MediaKeyServiceState {
  if (!input.keyConfigured) return "unconfigured";
  if (!input.priceConfigured) return "saved_not_ready";
  if (input.singleFailure) return "single_failure";
  return "ready";
}

export interface AdminMediaKeysBackend {
  view(): Promise<AdminMediaKeysView>;
  updateSlot(body: AdminMediaKeyUpdate): Promise<AdminMediaKeysView>;
}

/**
 * Media-key console service. Reuses MODEL_ADMIN_MASTER_KEY and a sibling private file next to models.enc.
 * After each save, hot-reloads the in-process ServerRealMediaRuntime so probes and generation see the new keys
 * without pretending a deploy happened.
 */
export class AdminMediaKeysService implements AdminMediaKeysBackend {
  private constructor(
    private readonly vault: MediaKeyVault,
    private readonly processMediaEnv: RealMediaEnvironment,
    private readonly apply: (managed: ManagedMediaKeys) => void,
    private appliedRevision: number,
  ) {}

  static async open(
    bootstrap: AdminBootstrap,
    processMediaEnv: RealMediaEnvironment,
    runtime: ServerRealMediaRuntime | null,
  ): Promise<AdminMediaKeysService> {
    const vault = await MediaKeyVault.open({
      path: mediaKeyVaultPath(bootstrap.path),
      masterKey: bootstrap.masterKey,
    });
    const doc = await vault.read();
    const apply = (managed: ManagedMediaKeys) => {
      const effective = applyManagedMediaKeys(processMediaEnv, managed);
      runtime?.reloadMediaApiKeys(effective);
    };
    apply(doc.saved);
    return new AdminMediaKeysService(vault, processMediaEnv, apply, doc.saved.revision);
  }

  /** Server-only; never returned by the controller. */
  async runtimeSettings(): Promise<ManagedMediaKeys> {
    return structuredClone((await this.vault.read()).saved);
  }

  async view(): Promise<AdminMediaKeysView> {
    const doc = await this.vault.read();
    return this.toView(doc.saved);
  }

  async updateSlot(body: AdminMediaKeyUpdate): Promise<AdminMediaKeysView> {
    try {
      const doc = await this.vault.updateSlot(body);
      // Hot reload into this API process immediately. Worker re-reads the same file before submit.
      this.apply(doc.saved);
      this.appliedRevision = doc.saved.revision;
      return this.toView(doc.saved);
    } catch (error) {
      if (error && typeof error === "object" && "status" in error && "code" in error) {
        const status = Number((error as { status: unknown }).status);
        const code = String((error as { code: unknown }).code);
        if (status === 409 && code === "ADMIN_CONFIG_CONFLICT") throw new AdminHttpError(409, "ADMIN_CONFIG_CONFLICT");
        if (status === 409 && code === "ADMIN_CONFIG_BUSY") throw new AdminHttpError(409, "ADMIN_CONFIG_BUSY");
        if (status === 400) throw new AdminHttpError(400, "ADMIN_CONFIG_INVALID");
        if (status === 503) throw new AdminHttpError(503, "ADMIN_CONFIG_STORAGE_UNAVAILABLE");
      }
      throw new AdminHttpError(503, "ADMIN_CONFIG_STORAGE_UNAVAILABLE");
    }
  }

  private toView(saved: ManagedMediaKeys): AdminMediaKeysView {
    const anyManaged = MEDIA_KEY_SLOTS.some((slot) => saved.slots[slot].managed);
    const pendingRestart = saved.revision !== this.appliedRevision;
    return {
      savedRevision: saved.revision,
      pendingRestart,
      source: anyManaged ? "managed" : "environment",
      slots: MEDIA_KEY_SLOTS.map((slot) => this.slotView(slot, saved, pendingRestart)),
      validation: "local_only",
      notices: [...NOTICES],
    };
  }

  private slotView(slot: MediaKeySlot, saved: ManagedMediaKeys, pendingRestart: boolean): AdminMediaKeySlotView {
    const entry = saved.slots[slot];
    const configured = mediaKeyPresent(saved, slot, this.processMediaEnv);
    let source: AdminMediaKeySlotView["source"] = "none";
    if (entry.managed) source = entry.apiKey !== null ? "managed" : "none";
    else if (configured) source = "environment";
    let status: AdminMediaKeySlotView["status"] = configured ? "saved" : "empty";
    // A managed key that this process has not loaded yet must not pretend the provider is connected.
    if (entry.managed && entry.apiKey !== null && pendingRestart) status = "pending_restart";
    const keyConfigured = configured && status !== "pending_restart";
    const priceConfigured = mediaKeyPriceConfigured(slot, this.processMediaEnv);
    return {
      slot,
      label: MEDIA_KEY_SLOT_LABELS[slot],
      hint: MEDIA_KEY_SLOT_HINTS[slot],
      keyConfigured,
      status,
      managed: entry.managed,
      source,
      priceConfigured,
      serviceState: mediaKeyServiceState({ keyConfigured, priceConfigured }),
    };
  }
}
