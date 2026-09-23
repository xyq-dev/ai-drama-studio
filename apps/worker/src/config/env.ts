import { z } from "zod";

const workerEnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  BIND_HOST: z.string().min(1).default("127.0.0.1"),
  WORKER_HEALTH_PORT: z.coerce.number().int().min(1).max(65535).default(3002),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  HEALTH_CHECK_TIMEOUT_MS: z.coerce.number().int().min(100).max(10_000).default(2000),
});

export class EnvValidationError extends Error {
  readonly fields: readonly string[];

  constructor(fields: readonly string[]) {
    super(`Invalid environment: ${fields.join(", ")}`);
    this.name = "EnvValidationError";
    this.fields = fields;
  }
}

export interface WorkerEnv {
  NODE_ENV: "development" | "test" | "production";
  BIND_HOST: string;
  WORKER_HEALTH_PORT: number;
  DATABASE_URL: string;
  REDIS_URL: string;
  HEALTH_CHECK_TIMEOUT_MS: number;
}

const WORKER_KEYS = [
  "NODE_ENV",
  "BIND_HOST",
  "WORKER_HEALTH_PORT",
  "DATABASE_URL",
  "REDIS_URL",
  "HEALTH_CHECK_TIMEOUT_MS",
] as const;

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

export function loadWorkerEnv(
  processEnv: Record<string, string | undefined>,
  fileEnv: Record<string, string> = {},
): WorkerEnv {
  const picked: Record<string, string> = {};
  for (const key of WORKER_KEYS) {
    const fromProcess = processEnv[key];
    const value = fromProcess !== undefined ? fromProcess : fileEnv[key];
    if (value !== undefined) {
      picked[key] = value;
    }
  }
  const parsed = workerEnvSchema.safeParse(picked);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((issue) => issue.path.map(String).join(".") || "environment");
    throw new EnvValidationError(fields);
  }
  assertProtocol("DATABASE_URL", parsed.data.DATABASE_URL, ["postgresql:", "postgres:"]);
  assertProtocol("REDIS_URL", parsed.data.REDIS_URL, ["redis:", "rediss:"]);
  return parsed.data;
}
