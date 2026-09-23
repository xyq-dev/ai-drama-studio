import { z } from "zod";

const adapterEnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  BIND_HOST: z.string().min(1).default("127.0.0.1"),
  COMFYUI_ADAPTER_PORT: z.coerce.number().int().min(1).max(65535).default(3003),
  COMFYUI_MODE: z.literal("stub").default("stub"),
  COMFYUI_BASE_URL: z.string().default(""),
});

export class EnvValidationError extends Error {
  readonly fields: readonly string[];

  constructor(fields: readonly string[]) {
    super(`Invalid environment: ${fields.join(", ")}`);
    this.name = "EnvValidationError";
    this.fields = fields;
  }
}

export interface AdapterEnv {
  NODE_ENV: "development" | "test" | "production";
  BIND_HOST: string;
  COMFYUI_ADAPTER_PORT: number;
  COMFYUI_MODE: "stub";
  COMFYUI_BASE_URL: string;
}

const ADAPTER_KEYS = [
  "NODE_ENV",
  "BIND_HOST",
  "COMFYUI_ADAPTER_PORT",
  "COMFYUI_MODE",
  "COMFYUI_BASE_URL",
] as const;

export function loadAdapterEnv(
  processEnv: Record<string, string | undefined>,
  fileEnv: Record<string, string> = {},
): AdapterEnv {
  const picked: Record<string, string> = {};
  for (const key of ADAPTER_KEYS) {
    const fromProcess = processEnv[key];
    const value = fromProcess !== undefined ? fromProcess : fileEnv[key];
    if (value !== undefined) {
      picked[key] = value;
    }
  }
  const parsed = adapterEnvSchema.safeParse(picked);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((issue) => issue.path.map(String).join(".") || "environment");
    throw new EnvValidationError(fields);
  }
  const baseUrl = parsed.data.COMFYUI_BASE_URL.trim();
  if (baseUrl.length > 0) {
    try {
      const url = new URL(baseUrl);
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new EnvValidationError(["COMFYUI_BASE_URL"]);
      }
    } catch (error) {
      if (error instanceof EnvValidationError) {
        throw error;
      }
      throw new EnvValidationError(["COMFYUI_BASE_URL"]);
    }
  }
  return parsed.data;
}
