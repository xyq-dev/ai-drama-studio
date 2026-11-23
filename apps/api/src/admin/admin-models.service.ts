import {
  WRITING_MODEL_CHANNELS, writingModelOptions, adminVendorKeySchema, adminVendorSaveSchema,
  type AdminVendorKey, type AdminVendorSave, type AdminVendorCheck, type AdminVendorCheckResult, type AdminVendorView,
  TITLE_WRITING_DEFAULT_MODELS, anthropicKeyProblem, anthropicWorkspaceIdValid, deepseekKeyProblem,
  type AdminLimitsUpdate, type AdminModelsView, type AdminProviderUpdate, type AdminSettingsView, type TitleWritingProviderKey,
} from "@ai-drama/contracts";
import {
  ANTHROPIC_MESSAGES_URL, DEEPSEEK_CHAT_COMPLETIONS_URL, OPENAI_RESPONSES_URL, parseModelList, titleWritingProviderConfigs,
} from "@ai-drama/providers";
import type { ApiEnv } from "../config/env";
import type { AdminBootstrap } from "./admin-bootstrap";
import type { AdminModelsBackend } from "./admin-models.controller";
import { AdminHttpError } from "./admin-auth";
import { checkVendorCatalog } from "./admin-vendor-probe";
import { ModelConfigVault, vendorRecord, type VendorRecord, type ManagedModelSettings } from "./model-config-vault";

const PROVIDERS = ["openai", "anthropic", "deepseek"] as const;
const LABELS = { openai: "OpenAI", anthropic: "Claude", deepseek: "DeepSeek" };

function key(value: string | undefined): string | null {
  return value && value.length >= 8 && value.length <= 256 && !/\s/u.test(value) ? value : null;
}
function models(value: string | undefined): string[] {
  const parsed = parseModelList(value);
  return parsed.ok ? parsed.models : [];
}

export function initialModelSettings(env: ApiEnv): ManagedModelSettings {
  // A malformed environment workspace id cannot be stored; seeding the Claude key without it would look ready and fail
  // every call, so neither is seeded and the console asks for the key (with the workspace id in its advanced setting).
  const workspace = env.ANTHROPIC_WORKSPACE_ID;
  const workspaceBroken = Boolean(workspace) && !anthropicWorkspaceIdValid(workspace!);
  return {
    revision: 0,
    // DeepSeek has no key in a new vault, so it cannot be its default yet.
    defaultProvider: env.TITLE_WRITING_DEFAULT_PROVIDER === "deepseek" ? null : env.TITLE_WRITING_DEFAULT_PROVIDER ?? null,
    maxCallsPerDay: env.TITLE_WRITING_MAX_CALLS_PER_DAY,
    maxActiveRuns: env.TITLE_WRITING_MAX_ACTIVE_RUNS,
    providers: {
      openai: { apiKey: key(env.OPENAI_API_KEY), models: models(env.TITLE_WRITING_OPENAI_MODELS), baseUrl: OPENAI_RESPONSES_URL },
      anthropic: { apiKey: workspaceBroken ? null : key(env.ANTHROPIC_API_KEY), models: models(env.TITLE_WRITING_ANTHROPIC_MODELS),
        baseUrl: ANTHROPIC_MESSAGES_URL, ...(workspace && !workspaceBroken ? { workspaceId: workspace } : {}) },
      // Never from the environment: a DEEPSEEK_* variable left from before the retirement must not come back to life.
      deepseek: { apiKey: null, models: [], baseUrl: DEEPSEEK_CHAT_COMPLETIONS_URL },
    },
  };
}

/** Explicit projection: managed clear never falls back to a stale environment secret. */
export function managedProviderConfigs(settings: ManagedModelSettings) {
  return titleWritingProviderConfigs({
    OPENAI_API_KEY: settings.providers.openai.apiKey ?? undefined,
    TITLE_WRITING_OPENAI_MODELS: settings.providers.openai.models.join(","),
    ANTHROPIC_API_KEY: settings.providers.anthropic.apiKey ?? undefined,
    TITLE_WRITING_ANTHROPIC_MODELS: settings.providers.anthropic.models.join(","),
    ANTHROPIC_WORKSPACE_ID: settings.providers.anthropic.workspaceId,
    DEEPSEEK_API_KEY: settings.providers.deepseek.apiKey ?? undefined,
    TITLE_WRITING_DEEPSEEK_MODELS: settings.providers.deepseek.models.join(","),
  });
}

function settingsView(settings: ManagedModelSettings): AdminSettingsView {
  const configs = managedProviderConfigs(settings);
  return {
    defaultProvider: settings.defaultProvider,
    maxCallsPerDay: settings.maxCallsPerDay,
    maxActiveRuns: settings.maxActiveRuns,
    providers: PROVIDERS.map((providerKey) => {
      const provider = settings.providers[providerKey];
      const config = configs[providerKey];
      return { providerKey, label: LABELS[providerKey], models: [...provider.models], baseUrl: provider.baseUrl,
        keyConfigured: provider.apiKey !== null, ...(providerKey === "anthropic" ? { workspaceId: provider.workspaceId ?? null } : {}),
        ready: config.ok, missing: [...config.missing] };
    }),
  };
}

function validateKey(providerKey: AdminVendorKey, body: AdminProviderUpdate | AdminVendorSave): void {
  if (providerKey === "anthropic" && body.secretAction === "replace") {
    const problem = body.apiKey === undefined ? "unsupported_format" : anthropicKeyProblem(body.apiKey);
    if (problem === "not_api_credential") throw new AdminHttpError(400, "ADMIN_CONFIG_KEY_KIND");
    if (problem !== null) throw new AdminHttpError(400, "ADMIN_CONFIG_KEY_FORMAT");
  }
  if (providerKey === "anthropic" && body.workspaceAction === "replace" && !anthropicWorkspaceIdValid(body.workspaceId ?? "")) {
    throw new AdminHttpError(400, "ADMIN_CONFIG_WORKSPACE_FORMAT");
  }
  // DeepSeek documents no key format: only a plausible length and header-safe characters are required.
  if (providerKey === "deepseek" && body.secretAction === "replace" && (body.apiKey === undefined || deepseekKeyProblem(body.apiKey) !== null)) {
    throw new AdminHttpError(400, "ADMIN_CONFIG_DEEPSEEK_KEY_FORMAT");
  }
  if (providerKey !== "anthropic" && body.workspaceAction && body.workspaceAction !== "keep") {
    throw new AdminHttpError(400, "ADMIN_CONFIG_INVALID");
  }
}

export class AdminModelsService implements AdminModelsBackend {
  private readonly catalogChecks = new Map<string, Promise<AdminVendorCheckResult>>();
  private constructor(
    private readonly vault: ModelConfigVault,
    private readonly effective: ManagedModelSettings,
    private readonly deferred: boolean,
    private readonly state: AdminModelsView["titleWriting"],
    private readonly fetchImpl: typeof fetch,
    private readonly storage: (() => Promise<NonNullable<AdminModelsView["storage"]>>) | null = null,
  ) {}

  static async open(env: ApiEnv, bootstrap: AdminBootstrap, isIdle: () => Promise<boolean>,
    titleWritingState: Pick<AdminModelsView["titleWriting"], "enabled" | "productionBlocked" | "siteOperator"> = {
      enabled: env.NODE_ENV !== "production" && env.TITLE_WRITING_ENABLED,
      productionBlocked: env.NODE_ENV === "production",
    },
    /** Reads whether the database can store title runs, Claude runs and online candidates. Never writes. */
    storage: (() => Promise<NonNullable<AdminModelsView["storage"]>>) | null = null,
    fetchImpl: typeof fetch = globalThis.fetch): Promise<AdminModelsService> {
    const vault = await ModelConfigVault.open({ path: bootstrap.path, masterKey: bootstrap.masterKey, initial: initialModelSettings(env) });
    // This runs before the API accepts requests or starts recovery. No live hot swap.
    const result = await vault.activateIfIdle(isIdle);
    return new AdminModelsService(vault, result.active, result.deferred, {
      // The runtime passes the same computed authorization used by the service and recovery engine.
      ...titleWritingState,
      operatorConfigured: Boolean(env.TITLE_WRITING_OPERATOR_TOKEN),
    }, fetchImpl, storage);
  }

  /** Server-only startup copy; never returned by the controller. */
  runtimeSettings(): ManagedModelSettings { return structuredClone(this.effective); }

  private vendorView(vendor: AdminVendorKey, record: VendorRecord): AdminVendorView {
    const allowlist = vendor === "openai" || vendor === "anthropic" ? managedProviderConfigs(this.effective)[vendor].models : null;
    return {
      vendor, channel: record.channel, model: record.model, revision: record.revision,
      models: writingModelOptions(vendor, record.channel, allowlist),
      keyConfigured: record.apiKey !== null,
      ...(vendor === "anthropic" ? { workspaceId: record.workspaceId ?? null } : {}),
    };
  }

  async vendors(): Promise<AdminVendorView[]> {
    const doc = await this.vault.read();
    return adminVendorKeySchema.options.map((vendor) => this.vendorView(vendor, vendorRecord(doc, vendor)));
  }

  async vendor(vendor: AdminVendorKey): Promise<AdminVendorView> {
    return this.vendorView(vendor, vendorRecord(await this.vault.read(), vendor));
  }

  /** Only used for explicit binding of a new feature draft. Running jobs read their own locked credential. */
  async vendorSecret(vendor: AdminVendorKey): Promise<string | null> {
    return vendorRecord(await this.vault.read(), vendor).apiKey;
  }

  async saveVendor(vendor: AdminVendorKey, input: AdminVendorSave): Promise<AdminVendorView> {
    if (!adminVendorSaveSchema.safeParse(input).success || input.channel !== WRITING_MODEL_CHANNELS[vendor].id) {
      throw new AdminHttpError(400, "ADMIN_CONFIG_INVALID");
    }
    validateKey(vendor, input);
    const current = await this.vendor(vendor);
    if (input.model !== null && !current.models.some(({ id }) => id === input.model) && input.model !== current.model) {
      throw new AdminHttpError(400, "ADMIN_CONFIG_INVALID");
    }
    return this.vendorView(vendor, await this.vault.saveVendor(vendor, input));
  }

  async checkVendor(vendor: AdminVendorKey, input: AdminVendorCheck): Promise<AdminVendorCheckResult> {
    const record = vendorRecord(await this.vault.read(), vendor);
    if (record.revision !== input.expectedRevision || record.model !== input.model || record.channel !== input.channel) {
      throw new AdminHttpError(409, "ADMIN_CONFIG_CONFLICT");
    }
    if (!record.apiKey || !this.vendorView(vendor, record).models.some(({ id }) => id === input.model)) {
      throw new AdminHttpError(400, "ADMIN_CONFIG_INVALID");
    }
    const flight = `${vendor}:${record.revision}`;
    const existing = this.catalogChecks.get(flight);
    if (existing) return existing;
    const check = checkVendorCatalog(vendor, input.model, record.apiKey, record.workspaceId, this.fetchImpl)
      .then(async (evidence) => {
        if ((await this.vendor(vendor)).revision !== record.revision) throw new AdminHttpError(409, "ADMIN_CONFIG_CONFLICT");
        return { ...evidence, vendor, channel: record.channel, model: input.model, revision: record.revision };
      }).finally(() => this.catalogChecks.delete(flight));
    this.catalogChecks.set(flight, check);
    return check;
  }

  /** Whether saved settings wait for the restart. Reads only the revision numbers; never a secret. */
  async pendingRestart(): Promise<boolean> {
    return (await this.vault.read()).saved.revision !== this.effective.revision;
  }

  async view(): Promise<AdminModelsView> {
    const doc = await this.vault.read();
    const retired = await this.vault.retiredNote();
    return {
      savedRevision: doc.saved.revision, activeRevision: this.effective.revision,
      pendingRestart: doc.saved.revision !== this.effective.revision, activationDeferred: this.deferred,
      source: doc.saved.revision === 0 ? "environment" : "managed",
      saved: settingsView(doc.saved), active: settingsView(this.effective), titleWriting: { ...this.state },
      audit: doc.audit, validation: "local_only", storage: await this.readStorage(),
      ...(retired ? { retired: { providers: retired.providers as NonNullable<AdminModelsView["retired"]>["providers"],
        retiredDefault: retired.retiredDefault as NonNullable<AdminModelsView["retired"]>["retiredDefault"], backupKept: retired.backupKept } } : {}),
    };
  }

  private async readStorage(): Promise<AdminModelsView["storage"]> {
    if (!this.storage) return null;
    try {
      return await this.storage();
    } catch {
      return null;
    }
  }

  /**
   * A Claude key alone is a complete setup: without a model list the documented default model is saved with it, and
   * with no default provider saved Claude becomes the default in the same write. The key must have the shape of a
   * Claude Console API key (sk-ant-api…, sk-ant-usr…, sk-ant-svc…); a subscription / Claude Code token, an Admin key,
   * a session value or a JWT is refused as a credential of the wrong kind, anything else as an unsupported format.
   * Neither check says the key works: only the provider can answer that.
   */
  async updateProvider(providerKey: TitleWritingProviderKey, body: AdminProviderUpdate): Promise<AdminModelsView> {
    validateKey(providerKey, body);
    const defaults = TITLE_WRITING_DEFAULT_MODELS[providerKey];
    // Only when a key is entered: saving an empty list with the key kept is how the list is emptied (not ready).
    const update = body.secretAction === "replace" && body.models.length === 0 && defaults.length > 0
      ? { ...body, models: [...defaults] } : body;
    // Saving a vendor key must not switch the current writing provider. 功能配置 → 编剧 is the enablement path.
    await this.vault.updateProvider(providerKey, update, {
      claimDefault: providerKey === "anthropic",
      makeDefault: false,
    });
    return this.view();
  }

  async updateLimits(body: AdminLimitsUpdate): Promise<AdminModelsView> {
    await this.vault.updateLimits(body);
    return this.view();
  }
}
