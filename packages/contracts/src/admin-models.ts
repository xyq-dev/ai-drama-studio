import { z } from "zod";
import { TITLE_WRITING_PROVIDER_KEYS, type TitleWritingProviderKey, type TitleWritingStoredProviderKey } from "./title-writing";

/** Only the active providers can be edited or made the default. Retired providers have no console entry. */
export const adminProviderKeySchema = z.enum(TITLE_WRITING_PROVIDER_KEYS);
const revision = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const adminProviderUpdateSchema = z.object({
  expectedRevision: revision,
  models: z.array(z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/)).max(10),
  baseUrl: z.string().max(512).optional(),
  secretAction: z.enum(["keep", "replace", "clear"]),
  apiKey: z.string().min(8).max(256).regex(/^\S+$/u).optional(),
}).strict().superRefine((value, ctx) => {
  if ((value.secretAction === "replace") !== (value.apiKey !== undefined)) {
    ctx.addIssue({ code: "custom", path: ["apiKey"], message: "Secret action and value do not match" });
  }
});
export const adminLimitsUpdateSchema = z.object({
  expectedRevision: revision,
  defaultProvider: adminProviderKeySchema.nullable(),
  maxCallsPerDay: z.number().int().min(1).max(500),
  maxActiveRuns: z.number().int().min(1).max(10),
}).strict();
export type AdminProviderUpdate = z.infer<typeof adminProviderUpdateSchema>;
export type AdminLimitsUpdate = z.infer<typeof adminLimitsUpdateSchema>;

export interface AdminSessionView {
  authenticated: true;
  csrfToken: string;
  expiresAt: string;
}
export interface AdminProviderView {
  providerKey: TitleWritingProviderKey;
  label: string;
  models: string[];
  baseUrl: string;
  keyConfigured: boolean;
  ready: boolean;
  missing: string[];
}
export interface AdminSettingsView {
  defaultProvider: TitleWritingProviderKey | null;
  maxCallsPerDay: number;
  maxActiveRuns: number;
  providers: AdminProviderView[];
}
export interface AdminAuditView {
  at: string;
  /** format_upgraded: the stored configuration was converted to the two-provider format; the original was kept. */
  action: "provider_updated" | "limits_updated" | "activated" | "format_upgraded";
  /** Entries written before the retirement may name a retired provider; they are history and stay as recorded. */
  providerKey?: TitleWritingStoredProviderKey;
  revision: number;
}
/** Secret values, prefixes and fingerprints must never be added to this public view. */
export interface AdminModelsView {
  savedRevision: number;
  activeRevision: number;
  pendingRestart: boolean;
  activationDeferred: boolean;
  source: "environment" | "managed";
  /**
   * operatorConfigured: TITLE_WRITING_OPERATOR_TOKEN is set (needed only without the site login). siteOperator: the site
   * login is on, so the signed-in administrator may start paid calls without any token.
   */
  titleWriting: { enabled: boolean; productionBlocked: boolean; operatorConfigured: boolean; siteOperator?: boolean };
  /**
   * Whether the database can store what the features need, read when the view is built: the title writing tables, Claude
   * runs (20261016000100_writing_provider_anthropic) and online candidates (20261016000200_writing_candidate). Null when
   * it could not be read.
   */
  storage?: { titleWriting: boolean; claude: boolean; candidates: boolean } | null;
  saved: AdminSettingsView;
  active: AdminSettingsView;
  audit: AdminAuditView[];
  validation: "local_only";
  /**
   * Present after a configuration of the retired three-provider format was read: what the conversion left out. Names
   * only; no secret, prefix or fingerprint. retiredDefault is the retired provider that was the default (the default
   * is now unset and must be chosen again).
   */
  retired?: { providers: TitleWritingStoredProviderKey[]; retiredDefault: TitleWritingStoredProviderKey | null; backupKept: boolean };
}

/**
 * What stands between the administrator and writing with Claude, in the order it has to be resolved. Each state is
 * distinct: a saved key is not an applied key, an applied key is not a migrated database, and none of them is a
 * verified model call.
 */
export type ClaudeSetupState =
  | "key_missing"
  | "pending_restart"
  | "activation_deferred"
  | "incomplete"
  | "feature_off"
  | "operator_missing"
  | "storage_unknown"
  | "migration_missing"
  | "ready";

export function claudeSetupState(view: AdminModelsView): { state: ClaudeSetupState; migrations: string[] } {
  const saved = view.saved.providers.find((provider) => provider.providerKey === "anthropic");
  const active = view.active.providers.find((provider) => provider.providerKey === "anthropic");
  const none = { migrations: [] as string[] };
  if (!saved?.keyConfigured) return { state: "key_missing", ...none };
  if (!active?.ready) {
    if (view.activationDeferred) return { state: "activation_deferred", ...none };
    if (view.pendingRestart) return { state: "pending_restart", ...none };
    return { state: "incomplete", ...none };
  }
  if (!view.titleWriting.enabled) return { state: "feature_off", ...none };
  if (!view.titleWriting.siteOperator && !view.titleWriting.operatorConfigured) return { state: "operator_missing", ...none };
  if (!view.storage) return { state: "storage_unknown", ...none };
  const migrations = [
    ...(view.storage.claude ? [] : ["20261016000100_writing_provider_anthropic"]),
    ...(view.storage.candidates ? [] : ["20261016000200_writing_candidate"]),
  ];
  if (!view.storage.titleWriting || migrations.length > 0) return { state: "migration_missing", migrations };
  return { state: "ready", migrations };
}
