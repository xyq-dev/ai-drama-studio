import { createHash } from "node:crypto";
import type { RealMediaConfiguration, RealMediaSnapshot } from "@ai-drama/contracts";
import { realMediaInputHash } from "@ai-drama/domain";
import { assertComfyUiSourceImage } from "./comfyui-image-bytes";
import {
  assertComfyUiImageInput,
  assertComfyUiPromptText,
  buildComfyUiPrompt,
  COMFYUI_IMAGE_MAX_BYTES,
  COMFYUI_IMAGE_PROVIDER_KEY,
  COMFYUI_OUTPUT_FOLDER,
  COMFYUI_OUTPUT_NODE,
  comfyUiRequiredNodes,
  comfyUiWorkflowDescriptors,
  isComfyUiId,
  isComfyUiImageSize,
  type ComfyUiImageSnapshot,
} from "./comfyui-workflows";
import {
  MediaSubmissionUnknownError,
  type MediaCapability,
  type MediaGenerationRequest,
  type MediaProviderAdapter,
  type MediaProviderObservation,
  type MediaProviderOutput,
  type MediaResolvedOutput,
  type MediaSubmitResult,
} from "./media-adapter";

const MAX_JSON = 2 * 1024 * 1024;
const RESULT_NAME = /^([a-f0-9-]{36})_\d{5,}_[.]png$/;
const REJECTED = new Set([400, 401, 403, 404, 413, 422, 429]);
type Phase = "queued" | "running" | "unavailable";
type Dictionary = Record<string, unknown>;

export interface ComfyUiImageAdapterOptions {
  baseUrl: string;
  allowedOrigins: readonly string[];
  apiKey?: string;
  targetedCancellation?: boolean;
  fetch?: typeof fetch;
}
export interface ComfyUiReadiness {
  state: "READY" | "UNREACHABLE" | "DEPENDENCY_MISSING";
  missingNodes: string[];
  missingModels: string[];
}

export function canonicalComfyUiOrigin(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("COMFYUI_ORIGIN_INVALID");
  }
  if (
    raw.trim() !== raw ||
    /[\\?#\s]/.test(raw) ||
    !/^https?:\/\/[^/]+\/?$/.test(raw) ||
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    !url.hostname
  )
    throw new Error("COMFYUI_ORIGIN_INVALID");
  return url.origin;
}

function record(value: unknown): Dictionary | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Dictionary)
    : undefined;
}

interface ResultHandle {
  filename: string;
  width: number;
  height: number;
}

function assertResultHandle(value: unknown): ResultHandle {
  const handle = record(value);
  if (
    !handle ||
    Object.keys(handle).sort().join(",") !== "filename,height,width" ||
    typeof handle.filename !== "string" ||
    handle.filename.length > 80 ||
    !isComfyUiId(RESULT_NAME.exec(handle.filename)?.[1]) ||
    !isComfyUiImageSize(handle.width, handle.height)
  ) {
    throw new Error("COMFYUI_OUTPUT_INVALID");
  }
  return handle as unknown as ResultHandle;
}

function queuePhase(queue: Dictionary, id: string): Phase {
  if (!Array.isArray(queue.queue_running) || !Array.isArray(queue.queue_pending))
    throw new Error("COMFYUI_QUEUE_INVALID");
  const has = (entry: unknown) => Array.isArray(entry) && entry[1] === id;
  if (queue.queue_running.some(has)) return "running";
  return queue.queue_pending.some(has) ? "queued" : "unavailable";
}

function failedSubmission(errorCode: string, errorMessage: string): MediaSubmitResult {
  return { kind: "failed", retryable: false, errorCode, errorMessage };
}

export class ComfyUiImageAdapter implements MediaProviderAdapter {
  readonly providerKey = COMFYUI_IMAGE_PROVIDER_KEY;
  readonly #origin: string;
  readonly #request: typeof fetch;
  readonly #configuration: RealMediaConfiguration;
  readonly #authorization: string | undefined;
  readonly cancel?: (providerRequestId: string) => Promise<void>;

  constructor(configuration: RealMediaConfiguration, options: ComfyUiImageAdapterOptions) {
    this.#origin = canonicalComfyUiOrigin(options.baseUrl);
    const allowlist = options.allowedOrigins.map(canonicalComfyUiOrigin);
    if (!allowlist.includes(this.#origin)) throw new Error("COMFYUI_ORIGIN_NOT_ALLOWED");
    if (options.apiKey !== undefined && !/^[\x21-\x7E]{8,512}$/.test(options.apiKey))
      throw new Error("COMFYUI_CREDENTIAL_INVALID");
    if (
      configuration.providerKey !== this.providerKey ||
      configuration.capability !== "image.generate" ||
      configuration.parameters.checkpoint !== configuration.model ||
      !Array.isArray(configuration.parameters.workflows) ||
      realMediaInputHash(configuration.parameters.workflows) !==
        realMediaInputHash(comfyUiWorkflowDescriptors(configuration.model))
    ) {
      throw new Error("COMFYUI_CONFIGURATION_INVALID");
    }
    this.#configuration = structuredClone(configuration);
    this.#request = options.fetch ?? fetch;
    this.#authorization = options.apiKey ? "Bearer " + options.apiKey : undefined;
    if (options.targetedCancellation === true) this.cancel = (id) => this.#cancelTarget(id);
  }

  capabilities(): readonly MediaCapability[] {
    return ["image.generate"];
  }

  async #http(
    path: string,
    options: { payload?: unknown; form?: FormData; maxBytes?: number; timeoutMs?: number } = {},
  ) {
    const url = new URL(path, this.#origin);
    if (url.origin !== this.#origin) throw new Error("COMFYUI_ORIGIN_NOT_ALLOWED");
    const post = options.payload !== undefined || options.form !== undefined;
    const response = await this.#request(url, {
      method: post ? "POST" : "GET",
      headers: {
        Accept: options.maxBytes === COMFYUI_IMAGE_MAX_BYTES ? "image/png" : "application/json",
        ...(this.#authorization ? { Authorization: this.#authorization } : {}),
        ...(options.payload === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body:
        options.form ??
        (options.payload === undefined ? undefined : JSON.stringify(options.payload)),
      redirect: "error",
      signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
    });
    const maximum = options.maxBytes ?? MAX_JSON;
    const length = response.headers.get("content-length");
    if (length !== null && (!/^\d+$/.test(length) || Number(length) > maximum)) {
      await response.body?.cancel();
      throw new Error("COMFYUI_RESPONSE_LIMIT");
    }
    const chunks: Uint8Array[] = [];
    let read = 0;
    if (response.body) {
      const reader = response.body.getReader();
      try {
        while (true) {
          const item = await reader.read();
          if (item.done) break;
          read += item.value.length;
          if (read > maximum) {
            await reader.cancel();
            throw new Error("COMFYUI_RESPONSE_LIMIT");
          }
          chunks.push(item.value);
        }
      } finally {
        reader.releaseLock();
      }
    }
    return {
      status: response.status,
      contentType: response.headers.get("content-type"),
      bytes: Buffer.concat(chunks, read),
    };
  }

  async #json(
    path: string,
    options: { payload?: unknown; form?: FormData; timeoutMs?: number } = {},
  ): Promise<Dictionary> {
    const response = await this.#http(path, options);
    if (response.status !== 200) throw new Error("COMFYUI_HTTP_FAILED");
    const value = record(JSON.parse(response.bytes.toString("utf8")));
    if (!value) throw new Error("COMFYUI_RESPONSE_INVALID");
    return value;
  }

  async checkReadiness(): Promise<ComfyUiReadiness> {
    const missingNodes: string[] = [];
    const missingModels: string[] = [];
    try {
      const system = await this.#json("/system_stats", { timeoutMs: 5000 });
      if (!record(system.system) || !Array.isArray(system.devices))
        throw new Error("COMFYUI_RESPONSE_INVALID");
      const nodes = comfyUiRequiredNodes();
      const entries = await Promise.all(
        Object.entries(nodes).map(async ([name, fields]) => {
          const response = await this.#http("/object_info/" + name, { timeoutMs: 5000 });
          if (response.status === 404) return { name, fields, node: undefined };
          if (response.status !== 200) throw new Error("COMFYUI_HTTP_FAILED");
          const data = record(JSON.parse(response.bytes.toString("utf8")));
          if (!data) throw new Error("COMFYUI_RESPONSE_INVALID");
          return { name, fields, node: record(data[name]) };
        }),
      );
      for (const { name, fields, node } of entries) {
        const required = record(record(node?.input)?.required);
        if (
          !node ||
          node.python_module !== "nodes" ||
          node.api_node === true ||
          !required ||
          fields.some((field) => !Object.hasOwn(required, field))
        ) {
          missingNodes.push(name);
          continue;
        }
        if (name === "CheckpointLoaderSimple") {
          const choices = required.ckpt_name;
          if (
            !Array.isArray(choices) ||
            !Array.isArray(choices[0]) ||
            !choices[0].includes(this.#configuration.model)
          ) {
            missingModels.push(this.#configuration.model);
          }
        }
      }
      return {
        state: missingNodes.length || missingModels.length ? "DEPENDENCY_MISSING" : "READY",
        missingNodes,
        missingModels,
      };
    } catch {
      return { state: "UNREACHABLE", missingNodes: [], missingModels: [] };
    }
  }

  async submit(request: MediaGenerationRequest): Promise<MediaSubmitResult> {
    if (!this.#configuration.enabled)
      return failedSubmission("COMFYUI_SUBMIT_DISABLED", "ComfyUI 图片生成未启用。");
    const snapshot = request.inputSnapshot as Partial<RealMediaSnapshot> | null;
    const fields = record(record(snapshot)?.comfyui);
    const frozen =
      fields &&
      ({
        workflowId: fields.workflowId,
        workflowVersion: fields.workflowVersion,
        workflowHash: fields.workflowHash,
        width: fields.width,
        height: fields.height,
        seed: fields.seed,
      } as ComfyUiImageSnapshot);
    if (
      !snapshot ||
      snapshot.schema !== "real-media.v1" ||
      !frozen ||
      snapshot.capability !== "image.generate" ||
      request.capability !== "image.generate" ||
      snapshot.shotRevisionId !== request.shotRevisionId ||
      request.providerConfigurationId !== this.#configuration.id ||
      !record(snapshot.configuration) ||
      realMediaInputHash(snapshot.configuration) !== realMediaInputHash(this.#configuration)
    ) {
      return failedSubmission("COMFYUI_SNAPSHOT_INVALID", "分镜生成配置已变化，请重新确认。");
    }
    try {
      assertComfyUiPromptText(snapshot.sourceText);
    } catch {
      return failedSubmission("COMFYUI_PROMPT_INVALID", "提示词必须是文字，不能引用本地模型文件。");
    }
    let graph: ReturnType<typeof buildComfyUiPrompt>;
    let referenceName: string | undefined;
    const reference = request.resolvedSourceImage;
    try {
      const hasReference = snapshot.sourceImage !== undefined;
      if (hasReference !== Boolean(reference)) throw new Error("COMFYUI_REFERENCE_INVALID");
      referenceName =
        reference &&
        "ads-comfyui-v1-" +
          request.jobAttemptId +
          (reference.mimeType === "image/png" ? ".png" : ".jpg");
      graph = buildComfyUiPrompt({
        configuration: this.#configuration,
        frozen,
        sourceText: snapshot.sourceText,
        referenceAssetId: snapshot.sourceImage?.assetId,
        uploadedImage: referenceName,
        attemptId: request.jobAttemptId,
      });
      if (reference && referenceName) {
        assertComfyUiSourceImage(reference.bytes, reference.mimeType);
        const checksum = createHash("sha256").update(reference.bytes).digest("hex");
        if (
          checksum !== reference.checksumSha256 ||
          checksum !== snapshot.sourceImage?.checksumSha256
        )
          throw new Error("COMFYUI_REFERENCE_INVALID");
      }
    } catch {
      return failedSubmission("COMFYUI_REFERENCE_INVALID", "工作流输入或参考图校验未通过。");
    }
    if (reference && referenceName) {
      try {
        const form = new FormData();
        form.set(
          "image",
          new Blob([Uint8Array.from(reference.bytes)], { type: reference.mimeType }),
          referenceName,
        );
        form.set("type", "input");
        form.set("overwrite", "true");
        const upload = await this.#json("/upload/image", { form, timeoutMs: 60_000 });
        if (upload.name !== referenceName || upload.type !== "input" || upload.subfolder !== "")
          throw new Error("COMFYUI_REFERENCE_UPLOAD_INVALID");
      } catch {
        // An upload transport failure cannot create a generation job.
        return failedSubmission("COMFYUI_UPLOAD_FAILED", "参考图上传未通过。");
      }
    }

    let promptId: string | undefined;
    try {
      const response = await this.#http("/prompt", {
        payload: { prompt: graph },
        timeoutMs: 30_000,
      });
      const value = record(JSON.parse(response.bytes.toString("utf8")));
      promptId = isComfyUiId(value?.prompt_id) ? value.prompt_id : undefined;
      if (!promptId && REJECTED.has(response.status) && record(value?.error)) {
        return failedSubmission(
          "COMFYUI_PROMPT_REJECTED",
          "ComfyUI 拒绝了工作流，请检查依赖与输入。",
        );
      }
      if (response.status !== 200 || !promptId || value?.error)
        throw new MediaSubmissionUnknownError(promptId);
      return {
        kind: "waiting",
        providerRequestId: promptId,
        nextPollAt: new Date(Date.now() + 5000).toISOString(),
      };
    } catch {
      throw new MediaSubmissionUnknownError(promptId);
    }
  }

  #observation(
    id: string,
    result: Pick<MediaProviderObservation, "state"> &
      Partial<{
        phase: Phase;
        errorCode: string;
        output: MediaProviderOutput;
      }>,
  ): MediaProviderObservation {
    const responseHash = realMediaInputHash({ id, ...result });
    const base = {
      responseHash,
      normalizedEventKey: "poll:" + responseHash,
      observedAt: new Date().toISOString(),
      ...(result.phase ? { metadata: { phase: result.phase } } : {}),
    };
    if (result.state === "SUCCEEDED" && result.output) {
      return {
        ...base,
        state: "SUCCEEDED",
        outputs: [result.output],
        accounting: { provider: this.providerKey, model: this.#configuration.model, costs: [] },
      };
    }
    if (result.state === "FAILED") {
      return {
        ...base,
        state: "FAILED",
        retryable: false,
        errorCode: result.errorCode ?? "COMFYUI_EXECUTION_FAILED",
        errorMessage: "ComfyUI 任务未产生有效结果。",
      };
    }
    return { ...base, state: result.state === "SUCCEEDED" ? "UNKNOWN" : result.state };
  }

  #historyOutput(id: string, item: Dictionary): MediaProviderOutput {
    const tuple = item.prompt;
    if (
      !Array.isArray(tuple) ||
      tuple[1] !== id ||
      !Array.isArray(tuple[4]) ||
      tuple[4].length !== 1 ||
      tuple[4][0] !== COMFYUI_OUTPUT_NODE
    ) {
      throw new Error("COMFYUI_OUTPUT_INVALID");
    }
    const graph = record(tuple[2]);
    const nodeInputs = (key: string) => record(record(graph?.[key])?.inputs);
    const prefix = nodeInputs(COMFYUI_OUTPUT_NODE)?.filename_prefix;
    const attemptId =
      typeof prefix === "string" ? prefix.slice(COMFYUI_OUTPUT_FOLDER.length + 1) : undefined;
    const sourceText = nodeInputs("6")?.text;
    const reference = nodeInputs("10")?.image;
    const dimensions = nodeInputs(reference === undefined ? "5" : "11");
    const seed = nodeInputs("3")?.seed;
    if (
      !isComfyUiId(attemptId) ||
      prefix !== COMFYUI_OUTPUT_FOLDER + "/" + attemptId ||
      typeof sourceText !== "string" ||
      typeof seed !== "number" ||
      typeof dimensions?.width !== "number" ||
      typeof dimensions.height !== "number" ||
      (reference !== undefined && typeof reference !== "string")
    ) {
      throw new Error("COMFYUI_OUTPUT_INVALID");
    }
    const fields = {
      workflowId: reference === undefined ? "sd15-txt2img" : "sd15-img2img",
      width: dimensions.width,
      height: dimensions.height,
      seed,
      referenceAssetId: reference === undefined ? undefined : attemptId,
    };
    const expected = buildComfyUiPrompt({
      configuration: this.#configuration,
      frozen: assertComfyUiImageInput(this.#configuration, fields),
      sourceText,
      referenceAssetId: fields.referenceAssetId,
      uploadedImage: reference,
      attemptId,
    });
    if (realMediaInputHash(graph) !== realMediaInputHash(expected))
      throw new Error("COMFYUI_OUTPUT_INVALID");
    const images = record(record(item.outputs)?.[COMFYUI_OUTPUT_NODE])?.images;
    if (!Array.isArray(images) || images.length !== 1) throw new Error("COMFYUI_OUTPUT_INVALID");
    const image = record(images[0]);
    if (
      !image ||
      image.type !== "output" ||
      image.subfolder !== COMFYUI_OUTPUT_FOLDER ||
      typeof image.filename !== "string" ||
      !image.filename.startsWith(attemptId + "_")
    ) {
      throw new Error("COMFYUI_OUTPUT_INVALID");
    }
    const handle = assertResultHandle({
      filename: image.filename,
      width: fields.width,
      height: fields.height,
    });
    return {
      kind: "IMAGE",
      mimeTypeHint: "image/png",
      metadata: { comfyUiAttemptId: attemptId },
      retrieval: {
        kind: "HANDLE",
        handle: Buffer.from(JSON.stringify(handle)).toString("base64url"),
      },
    };
  }

  #historyState(id: string, item: Dictionary): MediaProviderObservation | undefined {
    const status = record(item.status);
    if (!status) return undefined;
    if (
      Array.isArray(status.messages) &&
      status.messages.some(
        (event) =>
          Array.isArray(event) &&
          event[0] === "execution_interrupted" &&
          record(event[1])?.prompt_id === id,
      )
    ) {
      return this.#observation(id, { state: "CANCELED" });
    }
    if (status.status_str === "error") return this.#observation(id, { state: "FAILED" });
    if (status.status_str !== "success" || status.completed !== true) return undefined;
    try {
      return this.#observation(id, { state: "SUCCEEDED", output: this.#historyOutput(id, item) });
    } catch {
      return this.#observation(id, { state: "FAILED", errorCode: "COMFYUI_OUTPUT_INVALID" });
    }
  }

  async inspect(id: string): Promise<MediaProviderObservation> {
    if (!isComfyUiId(id)) throw new Error("COMFYUI_PROMPT_ID_INVALID");
    if (!this.#configuration.queryAllowed)
      return this.#observation(id, { state: "UNKNOWN", phase: "unavailable" });
    try {
      const history = await this.#json("/history/" + id);
      const item = record(history[id]);
      const status = item && this.#historyState(id, item);
      if (status) return status;
    } catch {
      /* Queue can still provide an authoritative stage when history is unavailable. */
    }
    try {
      const phase = queuePhase(await this.#json("/queue"), id);
      if (phase !== "unavailable") return this.#observation(id, { state: "ACTIVE", phase });
    } catch {
      /* Request identity remains valid and is rechecked by recovery. */
    }
    return this.#observation(id, { state: "UNKNOWN", phase: "unavailable" });
  }

  async resolveOutput(output: MediaProviderOutput): Promise<MediaResolvedOutput> {
    if (
      !this.#configuration.queryAllowed ||
      output.kind !== "IMAGE" ||
      output.mimeTypeHint !== "image/png" ||
      output.retrieval.kind !== "HANDLE" ||
      !/^[A-Za-z0-9_-]{1,240}$/.test(output.retrieval.handle)
    ) {
      throw new Error("COMFYUI_OUTPUT_INVALID");
    }
    let handle: ResultHandle;
    try {
      handle = assertResultHandle(
        JSON.parse(Buffer.from(output.retrieval.handle, "base64url").toString("utf8")),
      );
    } catch {
      throw new Error("COMFYUI_OUTPUT_INVALID");
    }
    const query = new URLSearchParams({
      filename: handle.filename,
      subfolder: COMFYUI_OUTPUT_FOLDER,
      type: "output",
    });
    let response: { status: number; contentType: string | null; bytes: Buffer };
    try {
      response = await this.#http("/view?" + query.toString(), {
        maxBytes: COMFYUI_IMAGE_MAX_BYTES,
        timeoutMs: 60_000,
      });
    } catch (error) {
      // eslint-disable-next-line preserve-caught-error -- Only a fixed error code crosses the provider boundary.
      throw new Error(
        error instanceof Error && error.message === "COMFYUI_RESPONSE_LIMIT"
          ? "COMFYUI_OUTPUT_INVALID"
          : "COMFYUI_OUTPUT_DOWNLOAD_FAILED",
      );
    }
    if (response.status !== 200) throw new Error("COMFYUI_OUTPUT_DOWNLOAD_FAILED");
    try {
      if (response.contentType?.split(";")[0]?.trim() !== "image/png")
        throw new Error("COMFYUI_OUTPUT_INVALID");
      const size = assertComfyUiSourceImage(response.bytes, "image/png");
      if (size.width !== handle.width || size.height !== handle.height)
        throw new Error("COMFYUI_OUTPUT_INVALID");
    } catch {
      throw new Error("COMFYUI_OUTPUT_INVALID");
    }
    return { uri: "data:image/png;base64," + response.bytes.toString("base64") };
  }

  async #cancelTarget(id: string): Promise<void> {
    if (!this.#configuration.queryAllowed) throw new Error("COMFYUI_CANCEL_UNSUPPORTED");
    if (!isComfyUiId(id)) throw new Error("COMFYUI_PROMPT_ID_INVALID");
    try {
      const initial = await this.inspect(id);
      if (initial.state === "CANCELED") return;
      if (initial.state !== "ACTIVE") throw new Error("COMFYUI_CANCEL_NOT_CONFIRMED");
      const response = await this.#json("/api/jobs/" + id + "/cancel", { payload: {} });
      if (response.cancelled !== true) throw new Error("COMFYUI_CANCEL_NOT_CONFIRMED");
      const history = await this.#json("/history/" + id);
      const item = record(history[id]);
      if (item) {
        if (this.#historyState(id, item)?.state === "CANCELED") return;
        throw new Error("COMFYUI_CANCEL_NOT_CONFIRMED");
      }
      const phase = queuePhase(await this.#json("/queue"), id);
      if (phase === "unavailable" && initial.metadata?.phase === "queued") {
        // The server proved a targeted cancellation happened. Re-check history
        // after the queue read in case the item raced from pending to running.
        const afterQueue = await this.#json("/history/" + id);
        const completed = record(afterQueue[id]);
        if (!completed || this.#historyState(id, completed)?.state === "CANCELED") return;
      }
    } catch {
      /* A failed or interrupted request cannot prove cancellation. */
    }
    throw new Error("COMFYUI_CANCEL_NOT_CONFIRMED");
  }
}
