import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  FEATURE_CAPABILITIES,
  FEATURE_KEYS,
  FEATURE_LABELS,
  FEATURE_PROBE_COST_NOTE,
  FEATURE_PROBE_SCALE,
  FEATURE_VENDOR_LABELS,
  featureChoiceBlock,
  featureModelLabel,
  formatCost,
  formatUsage,
  sumPresentCost,
  sumPresentUsage,
  usageRecordMatches,
  USAGE_FOOTNOTE,
  type FeatureCardView,
  type FeatureConfigView,
  type FeatureDraftSave,
  type FeatureEnableRequest,
  type FeatureRollbackRequest,
  type FeatureKey,
  type FeatureLiveView,
  type FeatureMutationResult,
  type FeatureSlotView,
  type FeatureTestRequest,
  type FeatureVendor,
  type UsageAmount,
  type UsageCost,
  type UsageRecordView,
  type UsageSummaryView,
} from "@ai-drama/contracts";
import {
  FeatureConfigVault,
  type FeatureSlotRecord,
  type FeatureVaultDocument,
} from "./feature-config-vault";
import {
  FeatureUsageStore,
  normalizeCost,
  normalizeUsage,
  type StoredLock,
  type StoredUsage,
} from "./feature-usage-store";

export interface FeatureServerBinding {
  source: "enabled" | "legacy";
  feature: FeatureKey;
  vendor: string;
  model: string;
  configVersion: string;
  credentialRef: string;
  /** Server only. Never copy this onto a view, log, trace, or usage row. */
  secret: string;
}

export interface FeatureProbeInput {
  feature: FeatureKey;
  vendor: string;
  model: string;
  apiKey: string;
  vendorRequestId: string;
  kind: "admin_test" | "production";
}

export interface FeatureProbeResult {
  ok: boolean;
  message?: string;
  usage?: UsageAmount;
  cost?: UsageCost;
}

export type FeatureProbe = (input: FeatureProbeInput) => Promise<FeatureProbeResult>;

export interface LegacyFeatureHint {
  vendor: string;
  model: string;
  vendorLabel: string;
  modelLabel: string;
}

export interface LegacyFeatureSource {
  live(): Promise<Record<FeatureKey, LegacyFeatureHint | null>>;
  /** Must answer only for this feature's own historical slot. A media key is not a writing key. */
  secret(feature: FeatureKey, vendor: string): Promise<string | null>;
}

export interface FeaturePolicy {
  writingAllowlist?: () => Promise<readonly string[] | null>;
  writingCallsRemaining?: () => Promise<number | null>;
}

export class FeatureConfigError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = "FeatureConfigError";
  }
}

/** Production default: no outbound vendor call. Tests inject a mock probe. */
export function networkRefusingFeatureProbe(): FeatureProbe {
  return async () => {
    throw new FeatureConfigError(503, "FEATURE_PROBE_REFUSED", "当前环境未接通供应商检测，测试没有发出。");
  };
}

function id(prefix: string): string {
  return `${prefix}_${randomBytes(12).toString("base64url")}`;
}

function fingerprint(feature: FeatureKey, vendor: string, model: string, credentialRef: string): string {
  return createHash("sha256").update(`${feature}\n${vendor}\n${model}\n${credentialRef}`).digest("hex");
}

function publicMessage(message: string | undefined, secret: string, ok: boolean): string {
  const fallback = ok ? "测试通过。可以启用这一份草稿。" : "测试没有通过，草稿已保留，可以重试。";
  if (!message || message.includes(secret) || message.length > 200) return fallback;
  return message;
}

function emptySlot(): FeatureSlotRecord {
  return {
    model: null, credentialRef: null, draftStatus: "blank", testToken: null,
    testedFingerprint: null, failureMessage: null, updatedAt: null,
  };
}

export class FeatureConfigService {
  private readonly inflight = new Map<string, { revision: number; promise: Promise<FeatureMutationResult> }>();
  private readonly productionFlights = new Map<string, Promise<{ ok: boolean; message: string; configVersion: string; vendor: string; model: string; credentialRef: string }>>();

  constructor(
    private readonly vault: FeatureConfigVault,
    private readonly usage: FeatureUsageStore,
    private readonly probe: FeatureProbe,
    private readonly legacy: LegacyFeatureSource | null,
    private readonly policy: FeaturePolicy,
    private readonly now: () => Date,
    private readonly homeWorkspaceId: string,
  ) {}

  static async open(options: {
    vault: FeatureConfigVault;
    usage: FeatureUsageStore;
    probe?: FeatureProbe;
    legacy?: LegacyFeatureSource | null;
    policy?: FeaturePolicy;
    now?: () => Date;
    homeWorkspaceId?: string;
  }): Promise<FeatureConfigService> {
    return new FeatureConfigService(
      options.vault,
      options.usage,
      options.probe ?? networkRefusingFeatureProbe(),
      options.legacy ?? null,
      options.policy ?? {},
      options.now ?? (() => new Date()),
      options.homeWorkspaceId ?? "",
    );
  }

  operatorUsage(projectId?: string | null, episodeId?: string | null, filter?: { feature?: string | null; vendor?: string | null; model?: string | null }): Promise<UsageSummaryView> {
    if (!this.homeWorkspaceId) throw new FeatureConfigError(503, "ADMIN_NOT_CONFIGURED", "管理员配置尚未就绪。");
    return this.usageSummary({ workspaceId: this.homeWorkspaceId, projectId, episodeId, ...filter });
  }

  operatorUsageDetail(recordId: string): Promise<UsageRecordView> {
    if (!this.homeWorkspaceId) throw new FeatureConfigError(503, "ADMIN_NOT_CONFIGURED", "管理员配置尚未就绪。");
    return this.usageDetail(this.homeWorkspaceId, recordId);
  }

  async view(): Promise<FeatureConfigView> {
    const doc = await this.vault.read();
    return this.toView(doc);
  }

  async saveDraft(feature: FeatureKey, body: FeatureDraftSave): Promise<FeatureConfigView> {
    await this.assertChoice(feature, body.vendor, body.model);
    const retained = new Set((await this.usage.read()).locks.map((item) => item.credentialRef));
    const doc = await this.vault.update((current) => {
      const slot = this.slot(current, feature, body.vendor);
      if (body.secretAction === "replace") {
        const ref = id("fc");
        current.credentials[ref] = body.apiKey!;
        slot.credentialRef = ref;
        this.pruneCredentials(current, retained);
      } else if (body.secretAction === "clear") {
        slot.credentialRef = null;
      }
      const changed = slot.model !== body.model || body.secretAction !== "keep";
      slot.model = body.model;
      if (!slot.credentialRef) {
        slot.draftStatus = "blank";
        slot.testToken = null;
        slot.testedFingerprint = null;
      } else if (changed || slot.draftStatus === "blank" || slot.draftStatus === "testing") {
        slot.draftStatus = "saved";
        slot.testToken = null;
        slot.testedFingerprint = null;
      }
      slot.failureMessage = null;
      slot.updatedAt = this.now().toISOString();
    }, body.expectedRevision);
    return this.toView(doc);
  }

  async testDraft(feature: FeatureKey, body: FeatureTestRequest): Promise<FeatureMutationResult> {
    if (body.confirmCost !== true) throw new FeatureConfigError(400, "FEATURE_TEST_UNCONFIRMED", "还没有确认测试费用，没有发起调用。");
    const key = `${feature}:${body.vendor}`;
    const current = this.inflight.get(key);
    if (current) {
      if (current.revision !== body.expectedRevision) {
        throw new FeatureConfigError(409, "FEATURE_TEST_STALE", "配置已更新，这次测试没有发出。请重新读取。");
      }
      return current.promise;
    }
    const promise = this.runTest(feature, body).finally(() => {
      if (this.inflight.get(key)?.promise === promise) this.inflight.delete(key);
    });
    this.inflight.set(key, { revision: body.expectedRevision, promise });
    return promise;
  }

  async enable(feature: FeatureKey, body: FeatureEnableRequest): Promise<FeatureConfigView> {
    const doc = await this.vault.read();
    const slot = doc.features[feature].slots[body.vendor] ?? emptySlot();
    if (!slot.model || !slot.credentialRef || !slot.testedFingerprint || slot.testToken !== body.testToken || slot.draftStatus !== "passed") {
      throw new FeatureConfigError(409, "FEATURE_TEST_REQUIRED", "只能启用刚刚测试通过的这一份草稿。");
    }
    if (slot.testedFingerprint !== fingerprint(feature, body.vendor, slot.model, slot.credentialRef)) {
      throw new FeatureConfigError(409, "FEATURE_TEST_STALE", "草稿在测试之后有变动，请重新测试。");
    }
    await this.assertChoice(feature, body.vendor, slot.model);
    const next = await this.vault.update((current) => {
      const fresh = current.features[feature].slots[body.vendor];
      if (!fresh?.model || !fresh.credentialRef || !fresh.testedFingerprint || fresh.testToken !== body.testToken || fresh.draftStatus !== "passed" || fresh.model !== slot.model || fresh.credentialRef !== slot.credentialRef) {
        throw new FeatureConfigError(409, "FEATURE_TEST_STALE", "草稿在测试之后有变动，请重新测试。");
      }
      const record = current.features[feature];
      if (record.live) record.previousLive = record.live;
      record.live = {
        versionId: id("ver"),
        vendor: body.vendor,
        model: fresh.model,
        credentialRef: fresh.credentialRef,
        fingerprint: fresh.testedFingerprint,
      };
      // A newly enabled version invalidates other vendors' test receipts; they must retest before enable.
      for (const [vendor, other] of Object.entries(record.slots)) {
        if (vendor === body.vendor || !other) continue;
        if (other.draftStatus === "passed") {
          // Keep the key and model, but drop the leftover receipt so this is not a pending change.
          other.draftStatus = "blank";
          other.testToken = null;
          other.testedFingerprint = null;
        }
      }
    }, body.expectedRevision);
    return this.toView(next);
  }

  /**
   * Restores the previous enabled version. One step only: the restored version does not become the next rollback target.
   * Usage locks are not rewritten.
   */
  async rollback(feature: FeatureKey, body: FeatureRollbackRequest): Promise<FeatureConfigView> {
    const next = await this.vault.update((current) => {
      const record = current.features[feature];
      if (!record.previousLive) throw new FeatureConfigError(409, "FEATURE_ROLLBACK_UNAVAILABLE", "没有可回退的上一配置版本。");
      record.live = record.previousLive;
      record.previousLive = null;
    }, body.expectedRevision);
    return this.toView(next);
  }

  /** Real business entry: the enabled version, or that feature's own legacy slot. Never another feature's key. */
  async readBinding(feature: FeatureKey): Promise<FeatureServerBinding | null> {
    const doc = await this.vault.read();
    const live = doc.features[feature].live;
    if (live) {
      const secret = doc.credentials[live.credentialRef];
      if (!secret) return null;
      return {
        source: "enabled", feature, vendor: live.vendor, model: live.model,
        configVersion: live.versionId, credentialRef: live.credentialRef, secret,
      };
    }
    const hint = this.legacy ? (await this.legacy.live())[feature] : null;
    if (!hint) return null;
    const secret = await this.legacy!.secret(feature, hint.vendor);
    if (!secret) return null;
    return {
      source: "legacy", feature, vendor: hint.vendor, model: hint.model,
      configVersion: `legacy:${feature}:${hint.vendor}`, credentialRef: `legacy:${feature}:${hint.vendor}`, secret,
    };
  }

  /**
   * Creator submission from an existing work. Locks the enabled version and calls only the injected probe.
   * The vendor request id is reserved before the probe, so a second concurrent submission does not call again.
   * A new id on the same task is a separate attempt.
   */
  async submitProduction(input: {
    feature: FeatureKey;
    workspaceId: string;
    projectId: string;
    episodeId: string;
    taskId: string;
    actorId: string;
    projectLabel: string;
    episodeLabel: string;
    vendorRequestId: string;
  }): Promise<{ ok: boolean; message: string; configVersion: string; vendor: string; model: string; credentialRef: string }> {
    const inflight = this.productionFlights.get(input.vendorRequestId);
    if (inflight) return inflight;
    const flight = this.executeProduction(input);
    this.productionFlights.set(input.vendorRequestId, flight);
    try {
      return await flight;
    } finally {
      if (this.productionFlights.get(input.vendorRequestId) === flight) this.productionFlights.delete(input.vendorRequestId);
    }
  }

  /** Keeps the credential a new writing or media task locked, including after later key rotation. */
  async rememberLock(lock: StoredLock): Promise<void> {
    await this.usage.update((doc) => {
      const again = doc.locks.find((item) => item.workspaceId === lock.workspaceId && item.taskId === lock.taskId && item.feature === lock.feature);
      if (!again) doc.locks.push(lock);
    });
  }

  async credentialForTask(feature: FeatureKey, workspaceId: string, taskId: string): Promise<{
    apiKey: string; model: string; vendor: string; versionId: string; credentialRef: string;
  } | null> {
    const lock = (await this.usage.read()).locks.find((item) => item.feature === feature && item.workspaceId === workspaceId && item.taskId === taskId);
    if (!lock) return null;
    const apiKey = await this.secretFor(lock);
    if (!apiKey) return null;
    return { apiKey, model: lock.model, vendor: lock.vendor, versionId: lock.versionId, credentialRef: lock.credentialRef };
  }

  /**
   * Records one real provider exchange. Duplicate vendorRequestId does not add a second row.
   * The secret is never accepted here.
   */
  async recordExecution(input: {
    feature: FeatureKey;
    workspaceId: string;
    projectId: string;
    projectLabel: string;
    episodeId: string | null;
    episodeLabel: string;
    taskId: string;
    actorId: string;
    vendor: string;
    model: string;
    configVersion: string | null;
    credentialRef: string | null;
    vendorRequestId: string;
    result: "succeeded" | "failed" | "unknown";
    usage?: UsageAmount;
    cost?: UsageCost;
  }): Promise<void> {
    await this.writeUsage({
      kind: "production",
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      projectLabel: input.projectLabel,
      episodeId: input.episodeId,
      episodeLabel: input.episodeLabel,
      taskId: input.taskId,
      actorId: input.actorId,
      feature: input.feature,
      vendor: input.vendor,
      model: input.model,
      configVersion: input.configVersion,
      credentialRef: input.credentialRef,
      result: input.result,
      usage: normalizeUsage(input.usage),
      cost: normalizeCost(input.cost),
      vendorRequestId: input.vendorRequestId,
    }, []);
  }

  async recordCallback(input: {
    vendorRequestId: string;
    workspaceId: string;
    usage?: UsageAmount;
    cost?: UsageCost;
    result?: "succeeded" | "failed" | "unknown";
  }): Promise<"duplicate" | "updated" | "missing"> {
    let outcome: "duplicate" | "updated" | "missing" = "missing";
    await this.usage.update((doc) => {
      const row = doc.records.find((item) => item.vendorRequestId === input.vendorRequestId && item.workspaceId === input.workspaceId);
      if (!row) return;
      const nextUsage = normalizeUsage(input.usage);
      const nextCost = normalizeCost(input.cost);
      const fillUsage = row.usage.status !== "present" && nextUsage.status === "present";
      const fillCost = row.cost.status !== "present" && nextCost.status === "present";
      if (!fillUsage && !fillCost) {
        outcome = "duplicate";
        return;
      }
      if (fillUsage) row.usage = nextUsage;
      if (fillCost) row.cost = nextCost;
      if (input.result && row.result === "unknown") row.result = input.result;
      outcome = "updated";
    });
    return outcome;
  }

  async usageSummary(input: { workspaceId: string; projectId?: string | null; episodeId?: string | null; feature?: string | null; vendor?: string | null; model?: string | null }): Promise<UsageSummaryView> {
    const records = (await this.usage.read()).records.filter((item) => item.workspaceId === input.workspaceId && item.kind === "production");
    const projects = unique(records.filter((item) => item.projectId).map((item) => ({ id: item.projectId!, label: item.projectLabel })));
    const projectId = input.projectId ?? projects[0]?.id ?? null;
    const episodes = unique(records.filter((item) => item.projectId === projectId && item.episodeId).map((item) => ({
      id: item.episodeId!, label: item.episodeLabel, projectId: item.projectId!,
    })));
    const episodeId = input.episodeId ?? episodes[0]?.id ?? null;
    const scoped = records.filter((item) => item.projectId === projectId && item.episodeId === episodeId);
    const visible = records.filter((item) => item.projectId === projectId && (item.episodeId === episodeId || item.episodeId === null));
    return {
      scope: "episode_production",
      projectId,
      episodeId,
      projects,
      episodes,
      totals: FEATURE_KEYS.map((feature) => ({
        feature,
        featureLabel: FEATURE_LABELS[feature],
        usageText: sumPresentUsage(scoped, feature),
        costText: sumPresentCost(scoped, feature),
      })),
      records: visible.map(toUsageView).filter((row) => usageRecordMatches(row, input)),
      footnote: USAGE_FOOTNOTE,
    };
  }

  async usageDetail(workspaceId: string, recordId: string): Promise<UsageRecordView> {
    const row = (await this.usage.read()).records.find((item) => item.id === recordId && item.workspaceId === workspaceId);
    if (!row || row.kind !== "production") throw new FeatureConfigError(404, "FEATURE_USAGE_NOT_FOUND", "没有这条调用记录。");
    return toUsageView(row);
  }

  private async runTest(feature: FeatureKey, body: FeatureTestRequest): Promise<FeatureMutationResult> {
    const before = await this.vault.read();
    if (before.revision !== body.expectedRevision) throw new FeatureConfigError(409, "ADMIN_CONFIG_CONFLICT", "配置已更新，请重新读取后再测试。");
    const slot = before.features[feature].slots[body.vendor] ?? emptySlot();
    if (!slot.model || !slot.credentialRef) throw new FeatureConfigError(400, "FEATURE_DRAFT_INCOMPLETE", "请先保存草稿，再测试这一份配置。");
    await this.assertChoice(feature, body.vendor, slot.model);
    const secret = before.credentials[slot.credentialRef];
    if (!secret) throw new FeatureConfigError(409, "FEATURE_DRAFT_INCOMPLETE", "草稿密钥不可用，没有发起调用。");
    const marked = await this.vault.update((current) => {
      const fresh = this.slot(current, feature, body.vendor);
      fresh.draftStatus = "testing";
      fresh.failureMessage = null;
      fresh.updatedAt = this.now().toISOString();
    }, body.expectedRevision);
    const vendorRequestId = `probe_${randomUUID()}`;
    const result = await this.callProbe({
      feature, vendor: body.vendor, model: slot.model, apiKey: secret, vendorRequestId, kind: "admin_test",
    }, secret);
    const message = publicMessage(result.message, secret, result.ok);
    const finger = fingerprint(feature, body.vendor, slot.model, slot.credentialRef);
    let view: FeatureConfigView;
    try {
      const finished = await this.vault.update((current) => {
        const fresh = current.features[feature].slots[body.vendor];
        if (!fresh || fresh.credentialRef !== slot.credentialRef || fresh.model !== slot.model || fresh.draftStatus !== "testing") {
          throw new FeatureConfigError(409, "FEATURE_TEST_STALE", "草稿在测试期间有变动，这次结果不能启用。");
        }
        fresh.testedFingerprint = finger;
        fresh.updatedAt = this.now().toISOString();
        if (result.ok) {
          fresh.draftStatus = "passed";
          fresh.testToken = id("tt");
          fresh.failureMessage = null;
        } else {
          fresh.draftStatus = "failed";
          fresh.testToken = null;
          fresh.failureMessage = message;
        }
      }, marked.revision);
      view = await this.toView(finished);
    } catch (error) {
      if (error instanceof FeatureConfigError && error.code === "FEATURE_TEST_STALE") throw error;
      throw new FeatureConfigError(409, "FEATURE_TEST_STALE", "草稿在测试期间有变动，这次结果不能启用。");
    }
    await this.writeUsage({
      kind: "admin_test",
      workspaceId: "admin-test",
      projectId: null,
      projectLabel: "管理员测试",
      episodeId: null,
      episodeLabel: "不计入分集",
      taskId: `admin-test:${feature}:${body.vendor}`,
      actorId: "operator",
      feature,
      vendor: body.vendor,
      model: slot.model,
      configVersion: null,
      credentialRef: slot.credentialRef,
      result: result.ok ? "succeeded" : "failed",
      usage: normalizeUsage(result.usage),
      cost: normalizeCost(result.cost),
      vendorRequestId,
    }, [secret]);
    return { view, probe: { ok: result.ok, message } };
  }

  private async callProbe(input: FeatureProbeInput, secret: string): Promise<FeatureProbeResult> {
    try {
      return await this.probe(input);
    } catch (error) {
      if (error instanceof FeatureConfigError) {
        return { ok: false, message: publicMessage(error.message, secret, false), usage: { status: "unknown" }, cost: { status: "unknown" } };
      }
      return { ok: false, message: publicMessage(undefined, secret, false), usage: { status: "unknown" }, cost: { status: "unknown" } };
    }
  }

  private async lockTask(input: {
    feature: FeatureKey; workspaceId: string; projectId: string; episodeId: string; taskId: string;
  }): Promise<StoredLock> {
    const found = (await this.usage.read()).locks.find((item) =>
      item.workspaceId === input.workspaceId && item.taskId === input.taskId && item.feature === input.feature);
    if (found) return found;
    const binding = await this.readBinding(input.feature);
    if (!binding) throw new FeatureConfigError(409, "FEATURE_NOT_CONFIGURED", "这项功能还没有可启用的配置，没有发起调用。");
    const lock: StoredLock = {
      workspaceId: input.workspaceId,
      taskId: input.taskId,
      feature: input.feature,
      versionId: binding.configVersion,
      credentialRef: binding.credentialRef,
      vendor: binding.vendor,
      model: binding.model,
      projectId: input.projectId,
      episodeId: input.episodeId,
    };
    await this.usage.update((doc) => {
      const again = doc.locks.find((item) => item.workspaceId === lock.workspaceId && item.taskId === lock.taskId && item.feature === lock.feature);
      if (!again) doc.locks.push(lock);
    });
    return (await this.usage.read()).locks.find((item) =>
      item.workspaceId === input.workspaceId && item.taskId === input.taskId && item.feature === input.feature) ?? lock;
  }

  private async secretFor(lock: StoredLock): Promise<string | null> {
    if (lock.credentialRef.startsWith("legacy:")) {
      const [, feature, vendor] = lock.credentialRef.split(":");
      if (feature !== lock.feature || !vendor || !this.legacy) return null;
      return this.legacy.secret(lock.feature, vendor);
    }
    const doc = await this.vault.read();
    return doc.credentials[lock.credentialRef] ?? null;
  }

  private async writeUsage(input: Omit<StoredUsage, "id" | "attempt" | "startedAt" | "finishedAt" | "vendorLabel" | "modelLabel">, secrets: string[]): Promise<void> {
    const startedAt = this.now().toISOString();
    await this.usage.update((doc) => {
      if (doc.records.some((item) => item.vendorRequestId === input.vendorRequestId)) return;
      const attempt = doc.records.filter((item) => item.workspaceId === input.workspaceId && item.taskId === input.taskId && item.feature === input.feature).length + 1;
      doc.records.push({
        ...input,
        vendorLabel: FEATURE_VENDOR_LABELS[input.vendor as FeatureVendor] ?? input.vendor,
        modelLabel: featureModelLabel(input.model),
        id: randomUUID(),
        attempt,
        startedAt,
        finishedAt: startedAt,
      });
    }, secrets);
  }

  private async assertChoice(feature: FeatureKey, vendor: string, model: string): Promise<void> {
    const block = featureChoiceBlock({
      feature,
      vendor,
      model,
      writingAllowlist: feature === "writing" && this.policy.writingAllowlist ? await this.policy.writingAllowlist() : null,
      writingCallsRemaining: feature === "writing" && this.policy.writingCallsRemaining ? await this.policy.writingCallsRemaining() : null,
    });
    if (!block.ok) throw new FeatureConfigError(400, block.code, block.message);
  }

  private slot(doc: FeatureVaultDocument, feature: FeatureKey, vendor: FeatureVendor): FeatureSlotRecord {
    const featureRecord = doc.features[feature];
    const existing = featureRecord.slots[vendor];
    if (existing) return existing;
    const created = emptySlot();
    featureRecord.slots[vendor] = created;
    return created;
  }

  private productionResult(row: StoredUsage): { ok: boolean; message: string; configVersion: string; vendor: string; model: string; credentialRef: string } {
    return {
      ok: row.result === "succeeded",
      message: row.result === "succeeded" ? "供应商已回传过这一笔，没有重复调用。" : "这一笔已经记录，没有重复调用。",
      configVersion: row.configVersion ?? "unknown",
      vendor: row.vendor,
      model: row.model,
      credentialRef: row.credentialRef ?? "unknown",
    };
  }

  private async executeProduction(input: {
    feature: FeatureKey;
    workspaceId: string;
    projectId: string;
    episodeId: string;
    taskId: string;
    actorId: string;
    projectLabel: string;
    episodeLabel: string;
    vendorRequestId: string;
  }): Promise<{ ok: boolean; message: string; configVersion: string; vendor: string; model: string; credentialRef: string }> {
    const existing = (await this.usage.read()).records.find((item) => item.vendorRequestId === input.vendorRequestId);
    if (existing) {
      if (existing.workspaceId !== input.workspaceId) throw new FeatureConfigError(404, "FEATURE_USAGE_NOT_FOUND", "没有这条调用记录。");
      return this.productionResult(existing);
    }
    const locked = await this.lockTask(input);
    const secret = await this.secretFor(locked);
    if (!secret) throw new FeatureConfigError(409, "FEATURE_NOT_CONFIGURED", "提交时锁定的配置已经不可用，没有改用其他服务商。");
    let reserved = false;
    await this.usage.update((doc) => {
      const again = doc.records.find((item) => item.vendorRequestId === input.vendorRequestId);
      if (again) return;
      reserved = true;
      const attempt = doc.records.filter((item) => item.workspaceId === input.workspaceId && item.taskId === input.taskId && item.feature === input.feature).length + 1;
      const startedAt = this.now().toISOString();
      doc.records.push({
        id: randomUUID(),
        kind: "production",
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        projectLabel: input.projectLabel,
        episodeId: input.episodeId,
        episodeLabel: input.episodeLabel,
        taskId: input.taskId,
        attempt,
        actorId: input.actorId,
        feature: input.feature,
        vendor: locked.vendor,
        vendorLabel: FEATURE_VENDOR_LABELS[locked.vendor as FeatureVendor] ?? locked.vendor,
        model: locked.model,
        modelLabel: featureModelLabel(locked.model),
        configVersion: locked.versionId,
        credentialRef: locked.credentialRef,
        result: "unknown",
        startedAt,
        finishedAt: null,
        usage: { status: "unknown" },
        cost: { status: "unknown" },
        vendorRequestId: input.vendorRequestId,
      });
    }, [secret]);
    if (!reserved) {
      const raced = (await this.usage.read()).records.find((item) => item.vendorRequestId === input.vendorRequestId);
      if (!raced || raced.workspaceId !== input.workspaceId) throw new FeatureConfigError(404, "FEATURE_USAGE_NOT_FOUND", "没有这条调用记录。");
      return this.productionResult(raced);
    }
    const result = await this.callProbe({
      feature: input.feature,
      vendor: locked.vendor,
      model: locked.model,
      apiKey: secret,
      vendorRequestId: input.vendorRequestId,
      kind: "production",
    }, secret);
    await this.usage.update((doc) => {
      const row = doc.records.find((item) => item.vendorRequestId === input.vendorRequestId && item.workspaceId === input.workspaceId);
      if (!row) return;
      row.result = result.ok ? "succeeded" : "failed";
      row.usage = normalizeUsage(result.usage);
      row.cost = normalizeCost(result.cost);
      row.finishedAt = this.now().toISOString();
    }, [secret]);
    return {
      ok: result.ok,
      message: publicMessage(result.message, secret, result.ok),
      configVersion: locked.versionId,
      vendor: locked.vendor,
      model: locked.model,
      credentialRef: locked.credentialRef,
    };
  }

  private pruneCredentials(doc: FeatureVaultDocument, retained: ReadonlySet<string>): void {
    const used = new Set<string>(retained);
    for (const feature of FEATURE_KEYS) {
      const record = doc.features[feature];
      if (record.live) used.add(record.live.credentialRef);
      if (record.previousLive) used.add(record.previousLive.credentialRef);
      for (const slot of Object.values(doc.features[feature].slots)) {
        if (slot?.credentialRef) used.add(slot.credentialRef);
      }
    }
    const refs = Object.keys(doc.credentials);
    if (refs.length <= 40) return;
    for (const ref of refs) {
      if (Object.keys(doc.credentials).length <= 40) break;
      if (!used.has(ref)) delete doc.credentials[ref];
    }
  }

  private async toView(doc: FeatureVaultDocument): Promise<FeatureConfigView> {
    const legacy = this.legacy ? await this.legacy.live() : { writing: null, storyboard: null, voice: null };
    return {
      revision: doc.revision,
      validation: "local_only",
      features: FEATURE_KEYS.map((feature) => this.card(feature, doc, legacy[feature])),
    };
  }

  private card(feature: FeatureKey, doc: FeatureVaultDocument, legacy: LegacyFeatureHint | null): FeatureCardView {
    const record = doc.features[feature];
    const live = record.live
      ? {
        source: "enabled" as const,
        vendor: record.live.vendor,
        vendorLabel: FEATURE_VENDOR_LABELS[record.live.vendor] ?? record.live.vendor,
        model: record.live.model,
        modelLabel: featureModelLabel(record.live.model),
        version: record.live.versionId,
      }
      : legacyView(legacy);
    const slots = FEATURE_CAPABILITIES[feature].map((capability) => this.slotView(feature, capability, record.slots[capability.vendor] ?? emptySlot(), record.live ?? null));
    const drafted = Object.values(record.slots).some((slot) => slot && slot.draftStatus !== "blank");
    return {
      feature,
      label: FEATURE_LABELS[feature],
      live,
      firstTime: !live && !drafted,
      slots,
      probeScale: FEATURE_PROBE_SCALE,
      probeCostNote: FEATURE_PROBE_COST_NOTE,
      canRollback: Boolean(record.previousLive),
    };
  }

  private slotView(feature: FeatureKey, capability: { vendor: FeatureVendor; connected: boolean; gap: string | null; models: readonly { id: string; label: string }[] }, slot: FeatureSlotRecord, live: { vendor: string; model: string; credentialRef: string } | null): FeatureSlotView {
    return {
      vendor: capability.vendor,
      label: feature === "writing" && capability.vendor === "bailian" ? "百炼千问" : FEATURE_VENDOR_LABELS[capability.vendor],
      connected: capability.connected,
      gap: capability.gap,
      models: capability.models.map((item) => ({ ...item })),
      model: slot.model,
      keyConfigured: Boolean(slot.credentialRef),
      draftStatus: slot.draftStatus,
      testToken: slot.draftStatus === "passed" ? slot.testToken : null,
      failureMessage: slot.failureMessage,
      isLive: Boolean(live && live.vendor === capability.vendor && live.model === slot.model && slot.credentialRef && live.credentialRef === slot.credentialRef),
    };
  }
}

function legacyView(hint: LegacyFeatureHint | null): FeatureLiveView | null {
  if (!hint) return null;
  return {
    source: "legacy",
    vendor: hint.vendor,
    vendorLabel: hint.vendorLabel,
    model: hint.model,
    modelLabel: hint.modelLabel,
    version: null,
  };
}

function toUsageView(row: StoredUsage): UsageRecordView {
  return {
    id: row.id,
    taskId: row.taskId,
    attempt: row.attempt,
    feature: row.feature,
    featureLabel: FEATURE_LABELS[row.feature],
    vendor: row.vendor,
    model: row.model,
    vendorLabel: row.vendorLabel || (FEATURE_VENDOR_LABELS[row.vendor as FeatureVendor] ?? row.vendor),
    modelLabel: row.modelLabel || featureModelLabel(row.model),
    configVersion: row.configVersion,
    result: row.result,
    startedAt: row.startedAt,
    usageText: formatUsage(row.usage),
    costText: formatCost(row.cost),
    projectId: row.projectId,
    projectLabel: row.projectLabel,
    episodeId: row.episodeId,
    episodeLabel: row.episodeLabel,
    kind: row.kind,
    credentialRef: row.credentialRef,
  };
}

function unique<T extends { id: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  return items.filter((item) => (seen.has(item.id) ? false : seen.add(item.id)));
}

// Re-export the binding name used by studio services. The interface above is the value.
export type { FeatureKey };
