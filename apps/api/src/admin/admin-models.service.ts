import {
  TITLE_WRITING_DEFAULT_MODELS, anthropicKeyProblem, anthropicWorkspaceIdValid,
  type AdminLimitsUpdate, type AdminModelsView, type AdminProviderUpdate, type AdminSettingsView, type TitleWritingProviderKey,
} from "@ai-drama/contracts";
import {
  ANTHROPIC_MESSAGES_URL, OPENAI_RESPONSES_URL, parseModelList, titleWritingProviderConfigs,
} from "@ai-drama/providers";
import type { ApiEnv } from "../config/env";
import type { AdminBootstrap } from "./admin-bootstrap";
import type { AdminModelsBackend } from "./admin-models.controller";
import { AdminHttpError } from "./admin-auth";
import { ModelConfigVault, type ManagedModelSettings } from "./model-config-vault";

const PROVIDERS = ["openai", "anthropic"] as const;
const LABELS = { openai: "OpenAI", anthropic: "Claude" };

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
    defaultProvider: env.TITLE_WRITING_DEFAULT_PROVIDER ?? null,
    maxCallsPerDay: env.TITLE_WRITING_MAX_CALLS_PER_DAY,
    maxActiveRuns: env.TITLE_WRITING_MAX_ACTIVE_RUNS,
    providers: {
      openai: { apiKey: key(env.OPENAI_API_KEY), models: models(env.TITLE_WRITING_OPENAI_MODELS), baseUrl: OPENAI_RESPONSES_URL },
      anthropic: { apiKey: workspaceBroken ? null : key(env.ANTHROPIC_API_KEY), models: models(env.TITLE_WRITING_ANTHROPIC_MODELS),
        baseUrl: ANTHROPIC_MESSAGES_URL, ...(workspace && !workspaceBroken ? { workspaceId: workspace } : {}) },
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

export class AdminModelsService implements AdminModelsBackend {
  private constructor(
    private readonly vault: ModelConfigVault,
    private readonly effective: ManagedModelSettings,
    private readonly deferred: boolean,
    private readonly state: AdminModelsView["titleWriting"],
    private readonly storage: (() => Promise<NonNullable<AdminModelsView["storage"]>>) | null = null,
  ) {}

  static async open(env: ApiEnv, bootstrap: AdminBootstrap, isIdle: () => Promise<boolean>,
    titleWritingState: Pick<AdminModelsView["titleWriting"], "enabled" | "productionBlocked" | "siteOperator"> = {
      enabled: env.NODE_ENV !== "production" && env.TITLE_WRITING_ENABLED,
      productionBlocked: env.NODE_ENV === "production",
    },
    /** Reads whether the database can store title runs, Claude runs and online candidates. Never writes. */
    storage: (() => Promise<NonNullable<AdminModelsView["storage"]>>) | null = null): Promise<AdminModelsService> {
    const vault = await ModelConfigVault.open({ path: bootstrap.path, masterKey: bootstrap.masterKey, initial: initialModelSettings(env) });
    // This runs before the API accepts requests or starts recovery. No live hot swap.
    const result = await vault.activateIfIdle(isIdle);
    return new AdminModelsService(vault, result.active, result.deferred, {
      // The runtime passes the same computed authorization used by the service and recovery engine.
      ...titleWritingState,
      operatorConfigured: Boolean(env.TITLE_WRITING_OPERATOR_TOKEN),
    }, storage);
  }

  /** Server-only startup copy; never returned by the controller. */
  runtimeSettings(): ManagedModelSettings { return structuredClone(this.effective); }

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
    if (providerKey === "anthropic" && body.secretAction === "replace") {
      const problem = body.apiKey === undefined ? "unsupported_format" : anthropicKeyProblem(body.apiKey);
      if (problem === "not_api_credential") throw new AdminHttpError(400, "ADMIN_CONFIG_KEY_KIND");
      if (problem !== null) throw new AdminHttpError(400, "ADMIN_CONFIG_KEY_FORMAT");
    }
    if (providerKey === "anthropic" && body.workspaceAction === "replace" && !anthropicWorkspaceIdValid(body.workspaceId ?? "")) {
      throw new AdminHttpError(400, "ADMIN_CONFIG_WORKSPACE_FORMAT");
    }
    const defaults = TITLE_WRITING_DEFAULT_MODELS[providerKey];
    // Only when a key is entered: saving an empty list with the key kept is how the list is emptied (not ready).
    const update = body.secretAction === "replace" && body.models.length === 0 && defaults.length > 0
      ? { ...body, models: [...defaults] } : body;
    await this.vault.updateProvider(providerKey, update, { claimDefault: providerKey === "anthropic" });
    return this.view();
  }

  async updateLimits(body: AdminLimitsUpdate): Promise<AdminModelsView> {
    await this.vault.updateLimits(body);
    return this.view();
  }
}
