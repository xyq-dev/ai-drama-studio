import { z } from "zod";
import type { TitleWritingProviderKey } from "./title-writing";

export const adminProviderKeySchema = z.enum(["qwen", "openai", "deepseek"]);
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
  action: "provider_updated" | "limits_updated" | "activated";
  providerKey?: TitleWritingProviderKey;
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
}
