import { z } from "zod";

export const SERVICE_NAME = {
  api: "api",
  worker: "worker",
  web: "web",
  comfyuiAdapter: "comfyui-adapter",
  mediaWorker: "media-worker",
} as const;

export type ServiceName = (typeof SERVICE_NAME)[keyof typeof SERVICE_NAME];

export const healthStatusSchema = z.enum(["ok", "degraded", "down"]);
export type HealthStatus = z.infer<typeof healthStatusSchema>;

export const dependencyStatusSchema = z.enum(["ok", "down"]);
export type DependencyStatus = z.infer<typeof dependencyStatusSchema>;

export const dependencyHealthSchema = z.object({
  status: dependencyStatusSchema,
});
export type DependencyHealth = z.infer<typeof dependencyHealthSchema>;

export const serviceHealthResponseSchema = z.object({
  service: z.string(),
  status: z.literal("ok"),
  version: z.string().optional(),
  timestamp: z.string(),
});
export type ServiceHealthResponse = z.infer<typeof serviceHealthResponseSchema>;

export const readyHealthResponseSchema = z.object({
  service: z.string(),
  status: z.enum(["ok", "degraded"]),
  timestamp: z.string(),
  dependencies: z.object({
    postgres: dependencyHealthSchema.optional(),
    redis: dependencyHealthSchema.optional(),
    objectStorage: dependencyHealthSchema.optional(),
  }),
});
export type ReadyHealthResponse = z.infer<typeof readyHealthResponseSchema>;

export const workerLiveResponseSchema = z.object({
  service: z.literal(SERVICE_NAME.worker),
  status: z.literal("ok"),
  version: z.string(),
  timestamp: z.string(),
});
export type WorkerLiveResponse = z.infer<typeof workerLiveResponseSchema>;

export const workerReadyResponseSchema = z.object({
  service: z.literal(SERVICE_NAME.worker),
  status: z.enum(["ok", "degraded"]),
  version: z.string(),
  timestamp: z.string(),
  dependencies: z.object({
    postgres: dependencyHealthSchema,
    redis: dependencyHealthSchema,
    queue: dependencyHealthSchema,
  }),
});
export type WorkerReadyResponse = z.infer<typeof workerReadyResponseSchema>;

export const adapterHealthResponseSchema = z.object({
  service: z.literal(SERVICE_NAME.comfyuiAdapter),
  status: z.enum(["ok", "degraded"]),
  mode: z.literal("stub"),
  comfyuiConfigured: z.boolean(),
  timestamp: z.string(),
});
export type AdapterHealthResponse = z.infer<typeof adapterHealthResponseSchema>;

export const mediaWorkerHealthResponseSchema = z.object({
  service: z.literal(SERVICE_NAME.mediaWorker),
  status: z.literal("ok"),
  mode: z.literal("stub"),
  ffmpegRequired: z.literal(false),
  timestamp: z.string(),
});
export type MediaWorkerHealthResponse = z.infer<typeof mediaWorkerHealthResponseSchema>;

export function parseReadyHealthResponse(value: unknown): ReadyHealthResponse | undefined {
  const parsed = readyHealthResponseSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}
