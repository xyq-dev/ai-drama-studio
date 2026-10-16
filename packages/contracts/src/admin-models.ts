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
  titleWriting: { enabled: boolean; productionBlocked: boolean; operatorConfigured: boolean };
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
