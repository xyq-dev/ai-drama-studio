import { z } from "zod";

const workerEnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  BIND_HOST: z.string().min(1).default("127.0.0.1"),
  WORKER_HEALTH_PORT: z.coerce.number().int().min(1).max(65535).default(3002),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  HEALTH_CHECK_TIMEOUT_MS: z.coerce.number().int().min(100).max(10_000).default(2000),
  MOCK_OBJECT_DIR: z.string().min(1).optional(),
  M3_MOCK_IMAGE_ENABLED: z.enum(["true", "false"]).default("false"),
  M3_MOCK_AV_ENABLED: z.enum(["true", "false"]).default("false"),
  M3_MOCK_SUBTITLE_MUSIC_ENABLED: z.enum(["true", "false"]).default("false"),
  M4_LOCAL_COMPOSE_ENABLED: z.enum(["true", "false"]).default("false"),
  M4_COMPOSE_WORK_DIR: z.string().min(1).optional(),
  M4_COMPOSE_OBJECT_DIR: z.string().min(1).optional(),
  M4_COMPOSE_PYTHON: z.string().min(1).default("python3"),
  M4_COMPOSE_HOLD_BEFORE_COMMIT_MS: z.coerce.number().int().min(0).max(120_000).default(0),
  M4_COMPOSE_LEASE_MS: z.coerce.number().int().min(1000).max(30_000).default(30_000),
  M4_COMPOSE_FAIL_INSIDE_COMMIT: z.enum(["true", "false"]).default("false"),
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
  MOCK_OBJECT_DIR?: string;
  M3_MOCK_IMAGE_ENABLED: boolean;
  M3_MOCK_AV_ENABLED: boolean;
  M3_MOCK_SUBTITLE_MUSIC_ENABLED: boolean;
  M4_LOCAL_COMPOSE_ENABLED: boolean;
  M4_COMPOSE_WORK_DIR?: string;
  M4_COMPOSE_OBJECT_DIR?: string;
  M4_COMPOSE_PYTHON: string;
  M4_COMPOSE_HOLD_BEFORE_COMMIT_MS: number;
  M4_COMPOSE_LEASE_MS: number;
  M4_COMPOSE_FAIL_INSIDE_COMMIT: boolean;
}

const WORKER_KEYS = [
  "NODE_ENV",
  "BIND_HOST",
  "WORKER_HEALTH_PORT",
  "DATABASE_URL",
  "REDIS_URL",
  "HEALTH_CHECK_TIMEOUT_MS",
  "MOCK_OBJECT_DIR",
  "M3_MOCK_IMAGE_ENABLED",
  "M3_MOCK_AV_ENABLED",
  "M3_MOCK_SUBTITLE_MUSIC_ENABLED",
  "M4_LOCAL_COMPOSE_ENABLED",
  "M4_COMPOSE_WORK_DIR",
  "M4_COMPOSE_OBJECT_DIR",
  "M4_COMPOSE_PYTHON",
  "M4_COMPOSE_HOLD_BEFORE_COMMIT_MS",
  "M4_COMPOSE_LEASE_MS",
  "M4_COMPOSE_FAIL_INSIDE_COMMIT",
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
  return {
    ...parsed.data,
    M3_MOCK_IMAGE_ENABLED: parsed.data.M3_MOCK_IMAGE_ENABLED === "true",
    M3_MOCK_AV_ENABLED: parsed.data.M3_MOCK_AV_ENABLED === "true",
    M3_MOCK_SUBTITLE_MUSIC_ENABLED: parsed.data.M3_MOCK_SUBTITLE_MUSIC_ENABLED === "true",
    M4_LOCAL_COMPOSE_ENABLED: parsed.data.M4_LOCAL_COMPOSE_ENABLED === "true",
    M4_COMPOSE_FAIL_INSIDE_COMMIT: parsed.data.M4_COMPOSE_FAIL_INSIDE_COMMIT === "true",
  };
}
