import { z } from "zod";
import { mediaSiteAuthenticationConfigured } from "@ai-drama/contracts";
import { loadRealMediaEnvironment, RealMediaEnvironmentError, type RealMediaEnvironment, type MediaS3Configuration } from "@ai-drama/providers";

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
  M4_MOCK_SAMPLE_VIDEO_ENABLED: z.enum(["true", "false"]).default("false"),
  M3_MOCK_SUBTITLE_MUSIC_ENABLED: z.enum(["true", "false"]).default("false"),
  M4_LOCAL_COMPOSE_ENABLED: z.enum(["true", "false"]).default("false"),
  M4_LOCAL_EPISODE_COMPOSE_ENABLED: z.enum(["true", "false"]).default("false"),
  M4_COMPOSE_WORK_DIR: z.string().min(1).optional(),
  M4_COMPOSE_OBJECT_DIR: z.string().min(1).optional(),
  M4_VOICE_COMPOSE_FONT_PATH: z.string().min(1).optional(),
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
  REAL_MEDIA_SITE_AUTH_CONFIGURED:boolean;
  REAL_MEDIA_ENV?: RealMediaEnvironment;
  REAL_MEDIA_WORKSPACE_ID?: string;
  REAL_MEDIA_S3?: MediaS3Configuration;
  NODE_ENV: "development" | "test" | "production";
  BIND_HOST: string;
  WORKER_HEALTH_PORT: number;
  DATABASE_URL: string;
  REDIS_URL: string;
  HEALTH_CHECK_TIMEOUT_MS: number;
  MOCK_OBJECT_DIR?: string;
  M3_MOCK_IMAGE_ENABLED: boolean;
  M3_MOCK_AV_ENABLED: boolean;
  M4_MOCK_SAMPLE_VIDEO_ENABLED: boolean;
  M3_MOCK_SUBTITLE_MUSIC_ENABLED: boolean;
  M4_LOCAL_COMPOSE_ENABLED: boolean;
  M4_LOCAL_EPISODE_COMPOSE_ENABLED: boolean;
  M4_COMPOSE_WORK_DIR?: string;
  M4_COMPOSE_OBJECT_DIR?: string;
  M4_VOICE_COMPOSE_FONT_PATH?: string;
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
  "M4_MOCK_SAMPLE_VIDEO_ENABLED",
  "M3_MOCK_SUBTITLE_MUSIC_ENABLED",
  "M4_LOCAL_COMPOSE_ENABLED",
  "M4_LOCAL_EPISODE_COMPOSE_ENABLED",
  "M4_COMPOSE_WORK_DIR",
  "M4_COMPOSE_OBJECT_DIR",
  "M4_VOICE_COMPOSE_FONT_PATH",
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
  let mediaEnvironment: RealMediaEnvironment;
  try { mediaEnvironment = loadRealMediaEnvironment(processEnv, fileEnv); }
  catch (error) {
    if (error instanceof RealMediaEnvironmentError) throw new EnvValidationError(error.fields.slice());
    throw error;
  }
  const hasMedia = Object.keys(mediaEnvironment).length > 0;
  const read = (name: string): string | undefined => processEnv[name] !== undefined ? processEnv[name] : fileEnv[name];
  let mediaS3: MediaS3Configuration | undefined;
  const workspaceId = hasMedia ? read("APP_WORKSPACE_ID") : undefined;
  if (hasMedia && (mediaEnvironment.REAL_MEDIA_ENABLED === "true" || mediaEnvironment.REAL_MEDIA_RECEIPT_KEY)) {
    const required = ["APP_WORKSPACE_ID", "S3_ENDPOINT", "S3_REGION", "S3_BUCKET", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"];
    const missing = required.filter(name => !read(name));
    if (missing.length) throw new EnvValidationError(missing);
    if (!z.string().uuid().safeParse(workspaceId).success) throw new EnvValidationError(["APP_WORKSPACE_ID"]);
    assertProtocol("S3_ENDPOINT", read("S3_ENDPOINT")!, ["http:", "https:"]);
    const style = read("S3_FORCE_PATH_STYLE") ?? "true";
    if (!["true", "false"].includes(style)) throw new EnvValidationError(["S3_FORCE_PATH_STYLE"]);
    mediaS3 = { endpoint: read("S3_ENDPOINT")!, region: read("S3_REGION")!, bucket: read("S3_BUCKET")!,
      accessKeyId: read("S3_ACCESS_KEY_ID")!, secretAccessKey: read("S3_SECRET_ACCESS_KEY")!, forcePathStyle: style === "true" };
  }
  return {
    ...parsed.data,
    REAL_MEDIA_SITE_AUTH_CONFIGURED:mediaSiteAuthenticationConfigured(processEnv,parsed.data.NODE_ENV),
    M3_MOCK_IMAGE_ENABLED: parsed.data.M3_MOCK_IMAGE_ENABLED === "true",
    M3_MOCK_AV_ENABLED: parsed.data.M3_MOCK_AV_ENABLED === "true",
    M4_MOCK_SAMPLE_VIDEO_ENABLED: parsed.data.M4_MOCK_SAMPLE_VIDEO_ENABLED === "true",
    M3_MOCK_SUBTITLE_MUSIC_ENABLED: parsed.data.M3_MOCK_SUBTITLE_MUSIC_ENABLED === "true",
    M4_LOCAL_COMPOSE_ENABLED: parsed.data.M4_LOCAL_COMPOSE_ENABLED === "true",
    M4_LOCAL_EPISODE_COMPOSE_ENABLED: parsed.data.M4_LOCAL_EPISODE_COMPOSE_ENABLED === "true",
    M4_COMPOSE_FAIL_INSIDE_COMMIT: parsed.data.M4_COMPOSE_FAIL_INSIDE_COMMIT === "true",
    ...(hasMedia ? { REAL_MEDIA_ENV: mediaEnvironment, REAL_MEDIA_WORKSPACE_ID: workspaceId } : {}),
    ...(mediaS3 ? { REAL_MEDIA_S3: mediaS3 } : {}),
  };
}
