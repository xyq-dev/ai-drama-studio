import { z } from "zod";

const apiEnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  BIND_HOST: z.string().min(1).default("127.0.0.1"),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  S3_ENDPOINT: z.string().min(1),
  S3_REGION: z.string().min(1),
  S3_BUCKET: z.string().min(1),
  S3_ACCESS_KEY_ID: z.string().min(1),
  S3_SECRET_ACCESS_KEY: z.string().min(1),
  S3_FORCE_PATH_STYLE: z.enum(["true", "false"]).default("true"),
  HEALTH_CHECK_TIMEOUT_MS: z.coerce.number().int().min(100).max(10_000).default(2000),
  APP_WORKSPACE_ID: z.string().uuid(),
});

export class EnvValidationError extends Error {
  readonly fields: readonly string[];

  constructor(fields: readonly string[]) {
    super(`Invalid environment: ${fields.join(", ")}`);
    this.name = "EnvValidationError";
    this.fields = fields;
  }
}

export interface ApiEnv {
  NODE_ENV: "development" | "test" | "production";
  BIND_HOST: string;
  API_PORT: number;
  DATABASE_URL: string;
  REDIS_URL: string;
  S3_ENDPOINT: string;
  S3_REGION: string;
  S3_BUCKET: string;
  S3_ACCESS_KEY_ID: string;
  S3_SECRET_ACCESS_KEY: string;
  S3_FORCE_PATH_STYLE: boolean;
  HEALTH_CHECK_TIMEOUT_MS: number;
  APP_WORKSPACE_ID: string;
}

const API_KEYS = [
  "NODE_ENV",
  "BIND_HOST",
  "API_PORT",
  "DATABASE_URL",
  "REDIS_URL",
  "S3_ENDPOINT",
  "S3_REGION",
  "S3_BUCKET",
  "S3_ACCESS_KEY_ID",
  "S3_SECRET_ACCESS_KEY",
  "S3_FORCE_PATH_STYLE",
  "HEALTH_CHECK_TIMEOUT_MS",
  "APP_WORKSPACE_ID",
] as const;

function pickEnv(
  processEnv: Record<string, string | undefined>,
  fileEnv: Record<string, string>,
): Record<string, string> {
  const picked: Record<string, string> = {};
  for (const key of API_KEYS) {
    const fromProcess = processEnv[key];
    const value = fromProcess !== undefined ? fromProcess : fileEnv[key];
    if (value !== undefined) {
      picked[key] = value;
    }
  }
  return picked;
}

function assertProtocol(field: string, value: string, protocols: readonly string[]): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new EnvValidationError([field]);
  }
  if (!protocols.includes(url.protocol)) {
    throw new EnvValidationError([field]);
  }
}

export function loadApiEnv(
  processEnv: Record<string, string | undefined>,
  fileEnv: Record<string, string> = {},
): ApiEnv {
  const parsed = apiEnvSchema.safeParse(pickEnv(processEnv, fileEnv));
  if (!parsed.success) {
    const fields = parsed.error.issues.map((issue) => issue.path.map(String).join(".") || "environment");
    throw new EnvValidationError(fields);
  }
  assertProtocol("DATABASE_URL", parsed.data.DATABASE_URL, ["postgresql:", "postgres:"]);
  assertProtocol("REDIS_URL", parsed.data.REDIS_URL, ["redis:", "rediss:"]);
  assertProtocol("S3_ENDPOINT", parsed.data.S3_ENDPOINT, ["http:", "https:"]);
  return {
    ...parsed.data,
    S3_FORCE_PATH_STYLE: parsed.data.S3_FORCE_PATH_STYLE === "true",
  };
}
