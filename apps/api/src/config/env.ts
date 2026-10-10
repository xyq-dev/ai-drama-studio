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
  M3_MOCK_IMAGE_ENABLED: z.enum(["true", "false"]).default("false"),
  M3_MOCK_AV_ENABLED: z.enum(["true", "false"]).default("false"),
  M4_MOCK_SAMPLE_VIDEO_ENABLED: z.enum(["true", "false"]).default("false"),
  M3_MOCK_SUBTITLE_MUSIC_ENABLED: z.enum(["true", "false"]).default("false"),
  MOCK_OBJECT_DIR: z.string().min(1).optional(),
  M4_LOCAL_COMPOSE_ENABLED: z.enum(["true", "false"]).default("false"),
  M4_LOCAL_EPISODE_COMPOSE_ENABLED: z.enum(["true", "false"]).default("false"),
  M4_COMPOSE_OBJECT_DIR: z.string().min(1).optional(),
  QWEN_WEB_WRITING_ENABLED: z.enum(["true", "false"]).default("false"),
  M3_CHARACTER_REFERENCE_GATE: z.enum(["legacy", "strict"]).default("legacy"),
  QWEN_WEB_OPERATOR_TOKEN: z.string().min(16).max(200).optional(),
  TITLE_WRITING_ENABLED: z.enum(["true", "false"]).default("false"),
  TITLE_WRITING_OPERATOR_TOKEN: z.string().min(16).max(200).optional(),
  TITLE_WRITING_DEFAULT_PROVIDER: z.enum(["qwen", "openai", "deepseek"]).optional(),
  TITLE_WRITING_MAX_CALLS_PER_DAY: z.coerce.number().int().min(1).max(500).default(30),
  TITLE_WRITING_MAX_ACTIVE_RUNS: z.coerce.number().int().min(1).max(10).default(1),
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
  M3_MOCK_IMAGE_ENABLED: boolean;
  M3_MOCK_AV_ENABLED: boolean;
  M4_MOCK_SAMPLE_VIDEO_ENABLED: boolean;
  M3_MOCK_SUBTITLE_MUSIC_ENABLED: boolean;
  MOCK_OBJECT_DIR?: string;
  M4_LOCAL_COMPOSE_ENABLED: boolean;
  M4_LOCAL_EPISODE_COMPOSE_ENABLED: boolean;
  M4_COMPOSE_OBJECT_DIR?: string;
  QWEN_WEB_WRITING_ENABLED: boolean;
  QWEN_WEB_OPERATOR_TOKEN?: string;
  /** legacy keeps the existing Mock video gate; strict requires selected, approved character reference images. */
  M3_CHARACTER_REFERENCE_GATE: "legacy" | "strict";
  /** Read from the process environment only, never from the .env file. Server-side secret. */
  DASHSCOPE_API_KEY?: string;
  BAILIAN_BASE_URL?: string;
  QWEN_WEB_MODEL?: string;
  /** Title-driven writing. Default off and forced off in production. */
  TITLE_WRITING_ENABLED: boolean;
  TITLE_WRITING_OPERATOR_TOKEN?: string;
  TITLE_WRITING_DEFAULT_PROVIDER?: "qwen" | "openai" | "deepseek";
  TITLE_WRITING_MAX_CALLS_PER_DAY: number;
  TITLE_WRITING_MAX_ACTIVE_RUNS: number;
  /** Process environment only, never the .env file. Server-side secrets and model allowlists. */
  TITLE_WRITING_QWEN_MODELS?: string;
  OPENAI_API_KEY?: string;
  TITLE_WRITING_OPENAI_MODELS?: string;
  DEEPSEEK_API_KEY?: string;
  TITLE_WRITING_DEEPSEEK_MODELS?: string;
  /** Administrator bootstrap is process-only. Saved model secrets live in the encrypted configuration vault. */
  MODEL_ADMIN_ENABLED?: string;
  /** No longer used (replaced by the site login); read only to warn that it can be removed. */
  MODEL_ADMIN_TOKEN?: string;
  MODEL_ADMIN_MASTER_KEY?: string;
  MODEL_ADMIN_CONFIG_PATH?: string;
  /** No longer used; read only to warn that it can be removed. */
  MODEL_ADMIN_PUBLIC_ORIGIN?: string;
  /** Site login (src/auth). Process environment only, never the .env file or NEXT_PUBLIC_*. */
  SITE_AUTH_ENABLED?: string;
  SITE_AUTH_USERNAME?: string;
  SITE_AUTH_PASSWORD_HASH?: string;
  SITE_AUTH_PUBLIC_ORIGIN?: string;
}

/** Provider secrets and endpoints are accepted only from the process environment. */
const PROCESS_ONLY_KEYS = [
  "DASHSCOPE_API_KEY",
  "BAILIAN_BASE_URL",
  "QWEN_WEB_MODEL",
  "TITLE_WRITING_QWEN_MODELS",
  "OPENAI_API_KEY",
  "TITLE_WRITING_OPENAI_MODELS",
  "DEEPSEEK_API_KEY",
  "TITLE_WRITING_DEEPSEEK_MODELS",
  "MODEL_ADMIN_ENABLED",
  "MODEL_ADMIN_TOKEN",
  "MODEL_ADMIN_MASTER_KEY",
  "MODEL_ADMIN_CONFIG_PATH",
  "MODEL_ADMIN_PUBLIC_ORIGIN",
  "SITE_AUTH_ENABLED",
  "SITE_AUTH_USERNAME",
  "SITE_AUTH_PASSWORD_HASH",
  "SITE_AUTH_PUBLIC_ORIGIN",
] as const;

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
  "M3_MOCK_IMAGE_ENABLED",
  "M3_MOCK_AV_ENABLED",
  "M4_MOCK_SAMPLE_VIDEO_ENABLED",
  "M3_MOCK_SUBTITLE_MUSIC_ENABLED",
  "MOCK_OBJECT_DIR",
  "M4_LOCAL_COMPOSE_ENABLED",
  "M4_LOCAL_EPISODE_COMPOSE_ENABLED",
  "M4_COMPOSE_OBJECT_DIR",
  "QWEN_WEB_WRITING_ENABLED",
  "QWEN_WEB_OPERATOR_TOKEN",
  "M3_CHARACTER_REFERENCE_GATE",
  "TITLE_WRITING_ENABLED",
  "TITLE_WRITING_OPERATOR_TOKEN",
  "TITLE_WRITING_DEFAULT_PROVIDER",
  "TITLE_WRITING_MAX_CALLS_PER_DAY",
  "TITLE_WRITING_MAX_ACTIVE_RUNS",
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
  const processOnly: Partial<Record<(typeof PROCESS_ONLY_KEYS)[number], string>> = {};
  for (const key of PROCESS_ONLY_KEYS) {
    const value = processEnv[key];
    if (value !== undefined && value.length > 0) processOnly[key] = value;
  }
  return {
    ...parsed.data,
    ...processOnly,
    S3_FORCE_PATH_STYLE: parsed.data.S3_FORCE_PATH_STYLE === "true",
    M3_MOCK_IMAGE_ENABLED: parsed.data.M3_MOCK_IMAGE_ENABLED === "true",
    M3_MOCK_AV_ENABLED: parsed.data.M3_MOCK_AV_ENABLED === "true",
    M4_MOCK_SAMPLE_VIDEO_ENABLED: parsed.data.M4_MOCK_SAMPLE_VIDEO_ENABLED === "true",
    M3_MOCK_SUBTITLE_MUSIC_ENABLED: parsed.data.M3_MOCK_SUBTITLE_MUSIC_ENABLED === "true",
    M4_LOCAL_COMPOSE_ENABLED: parsed.data.M4_LOCAL_COMPOSE_ENABLED === "true",
    M4_LOCAL_EPISODE_COMPOSE_ENABLED: parsed.data.M4_LOCAL_EPISODE_COMPOSE_ENABLED === "true",
    QWEN_WEB_WRITING_ENABLED: parsed.data.QWEN_WEB_WRITING_ENABLED === "true",
    TITLE_WRITING_ENABLED: parsed.data.TITLE_WRITING_ENABLED === "true",
  };
}
