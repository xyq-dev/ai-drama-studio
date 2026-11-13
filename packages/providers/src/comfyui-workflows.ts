import type { RealMediaConfiguration } from "@ai-drama/contracts";
import { realMediaInputHash } from "@ai-drama/domain";

export const COMFYUI_IMAGE_PROVIDER_KEY = "comfyui";
export const COMFYUI_IMAGE_MAX_BYTES = 8 * 1024 * 1024;
export const COMFYUI_OUTPUT_FOLDER = "ads-comfyui-v1";
export const COMFYUI_OUTPUT_NODE = "9";
const CHECKPOINT = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,119}\.safetensors$/;
const MAX_PROMPT_LENGTH = 2000;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

type WorkflowNode = { class_type: string; inputs: Record<string, unknown> };
type Workflow = Record<string, WorkflowNode>;

// Adapted from the official API prompt example, with the operator's reviewed
// checkpoint replacing the example filename. The reference graph uses the
// official img2img LoadImage → VAEEncode pattern with built-in ImageScale.
const textGraph: Workflow = {
  "3": {
    class_type: "KSampler",
    inputs: {
      model: ["4", 0],
      positive: ["6", 0],
      negative: ["7", 0],
      latent_image: ["5", 0],
      seed: 0,
      steps: 20,
      cfg: 8,
      sampler_name: "euler",
      scheduler: "normal",
      denoise: 1,
    },
  },
  "4": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "" } },
  "5": { class_type: "EmptyLatentImage", inputs: { width: 512, height: 512, batch_size: 1 } },
  "6": { class_type: "CLIPTextEncode", inputs: { text: "", clip: ["4", 1] } },
  "7": { class_type: "CLIPTextEncode", inputs: { text: "", clip: ["4", 1] } },
  "8": { class_type: "VAEDecode", inputs: { samples: ["3", 0], vae: ["4", 2] } },
  "9": { class_type: "SaveImage", inputs: { filename_prefix: "", images: ["8", 0] } },
};
const referenceGraph: Workflow = {
  ...textGraph,
  "3": { ...textGraph["3"]!, inputs: { ...textGraph["3"]!.inputs, denoise: 0.65 } },
  "5": { class_type: "VAEEncode", inputs: { pixels: ["11", 0], vae: ["4", 2] } },
  "10": { class_type: "LoadImage", inputs: { image: "" } },
  "11": {
    class_type: "ImageScale",
    inputs: {
      image: ["10", 0],
      width: 512,
      height: 512,
      upscale_method: "lanczos",
      crop: "center",
    },
  },
};
const workflows = {
  "sd15-txt2img": { graph: textGraph, requiresReference: false, dimensionNode: "5" },
  "sd15-img2img": { graph: referenceGraph, requiresReference: true, dimensionNode: "11" },
} as const;
const sizes = [
  { width: 512, height: 512 },
  { width: 512, height: 768 },
  { width: 768, height: 512 },
  { width: 576, height: 1024 },
  { width: 1024, height: 576 },
] as const;
const version = "v1";
type WorkflowId = keyof typeof workflows;

export interface ComfyUiWorkflowDescriptor {
  id: WorkflowId;
  version: string;
  hash: string;
  requiresReference: boolean;
  sizes: Array<{ width: number; height: number }>;
  model: string;
  outputNode: string;
}
export interface ComfyUiImageInput {
  workflowId: string;
  width: number;
  height: number;
  seed: number;
  referenceAssetId?: string;
}
export interface ComfyUiImageSnapshot {
  workflowId: string;
  workflowVersion: string;
  workflowHash: string;
  width: number;
  height: number;
  seed: number;
}

export function isComfyUiCheckpoint(value: unknown): value is string {
  return typeof value === "string" && CHECKPOINT.test(value) && !value.includes("..");
}
export function isComfyUiId(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

export function comfyUiWorkflowDescriptors(checkpoint: string): ComfyUiWorkflowDescriptor[] {
  if (!isComfyUiCheckpoint(checkpoint)) throw new Error("COMFYUI_CHECKPOINT_INVALID");
  return (Object.keys(workflows) as WorkflowId[]).map((id) => {
    const { graph, requiresReference, dimensionNode } = workflows[id];
    const constraints = {
      id,
      version,
      model: checkpoint,
      requiresReference,
      dimensionNode,
      sizes,
      outputNode: COMFYUI_OUTPUT_NODE,
      inputNodes: {
        prompt: "6",
        seed: "3",
        size: dimensionNode,
        ...(requiresReference ? { image: "10" } : {}),
      },
      seedRange: [0, 0xffffffff],
      promptPolicy: "plain-text-v1",
      outputFolder: COMFYUI_OUTPUT_FOLDER,
    };
    return {
      id,
      version,
      hash: realMediaInputHash({ constraints, graph }),
      requiresReference,
      sizes: sizes.map((size) => ({ ...size })),
      model: checkpoint,
      outputNode: COMFYUI_OUTPUT_NODE,
    };
  });
}

export function assertComfyUiImageInput(
  configuration: RealMediaConfiguration,
  input: ComfyUiImageInput,
): ComfyUiImageSnapshot {
  const descriptor = comfyUiWorkflowDescriptors(configuration.model).find(
    (candidate) => candidate.id === input.workflowId,
  );
  const configured = Array.isArray(configuration.parameters.workflows)
    ? (configuration.parameters.workflows.find(
        (candidate: unknown) =>
          typeof candidate === "object" &&
          candidate !== null &&
          "id" in candidate &&
          candidate.id === input.workflowId,
      ) as unknown)
    : undefined;
  if (
    configuration.providerKey !== COMFYUI_IMAGE_PROVIDER_KEY ||
    configuration.capability !== "image.generate" ||
    configuration.parameters.checkpoint !== configuration.model ||
    !descriptor ||
    !configured ||
    realMediaInputHash(configured) !== realMediaInputHash(descriptor)
  ) {
    throw new Error("COMFYUI_WORKFLOW_UNAVAILABLE");
  }
  if (
    (input.referenceAssetId !== undefined && !isComfyUiId(input.referenceAssetId)) ||
    descriptor.requiresReference !== (input.referenceAssetId !== undefined) ||
    !descriptor.sizes.some((size) => size.width === input.width && size.height === input.height) ||
    !Number.isInteger(input.seed) ||
    input.seed < 0 ||
    input.seed > 0xffffffff
  ) {
    throw new Error("COMFYUI_WORKFLOW_INPUT_INVALID");
  }
  return {
    workflowId: descriptor.id,
    workflowVersion: descriptor.version,
    workflowHash: descriptor.hash,
    width: input.width,
    height: input.height,
    seed: input.seed,
  };
}

export function comfyUiRequiredNodes(): Record<string, readonly string[]> {
  const nodes: Record<string, readonly string[]> = {};
  for (const { graph } of Object.values(workflows)) {
    for (const node of Object.values(graph)) nodes[node.class_type] = Object.keys(node.inputs);
  }
  return nodes;
}

export function assertComfyUiPromptText(text: unknown): asserts text is string {
  // The built-in SD1.5 tokenizer interprets "embedding:" as a local model-file reference.
  if (
    typeof text !== "string" ||
    !text.trim() ||
    text.length > MAX_PROMPT_LENGTH ||
    /embedding:/i.test(text) ||
    text.includes("\0")
  )
    throw new Error("COMFYUI_PROMPT_INVALID");
}

export function buildComfyUiPrompt(input: {
  configuration: RealMediaConfiguration;
  frozen: ComfyUiImageSnapshot;
  sourceText: string;
  referenceAssetId?: string;
  uploadedImage?: string;
  attemptId: string;
}): Workflow {
  const expected = assertComfyUiImageInput(input.configuration, {
    ...input.frozen,
    referenceAssetId: input.referenceAssetId,
  });
  assertComfyUiPromptText(input.sourceText);
  if (
    realMediaInputHash(input.frozen) !== realMediaInputHash(expected) ||
    !isComfyUiId(input.attemptId)
  )
    throw new Error("COMFYUI_WORKFLOW_INPUT_INVALID");
  const workflow = workflows[expected.workflowId as WorkflowId];
  const expectedUpload = "ads-comfyui-v1-" + input.attemptId;
  if (
    workflow.requiresReference
      ? input.uploadedImage !== expectedUpload + ".png" &&
        input.uploadedImage !== expectedUpload + ".jpg"
      : input.uploadedImage !== undefined
  )
    throw new Error("COMFYUI_REFERENCE_INVALID");
  const graph = structuredClone(workflow.graph);
  graph["3"]!.inputs.seed = expected.seed;
  graph["4"]!.inputs.ckpt_name = input.configuration.model;
  graph[workflow.dimensionNode]!.inputs.width = expected.width;
  graph[workflow.dimensionNode]!.inputs.height = expected.height;
  graph["6"]!.inputs.text = input.sourceText;
  graph[COMFYUI_OUTPUT_NODE]!.inputs.filename_prefix =
    COMFYUI_OUTPUT_FOLDER + "/" + input.attemptId;
  if (workflow.requiresReference) graph["10"]!.inputs.image = input.uploadedImage;
  return graph;
}

/** Only dimensions approved for a v1 graph may leave the adapter as output. */
export function isComfyUiImageSize(width: unknown, height: unknown): boolean {
  return sizes.some((size) => size.width === width && size.height === height);
}
