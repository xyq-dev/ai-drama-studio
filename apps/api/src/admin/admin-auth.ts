/**
 * Error vocabulary and response headers of the model console. Authentication is the site login (src/auth): the
 * earlier token login (MODEL_ADMIN_TOKEN) and its /api/v1/admin-scoped cookie are gone, so a token cannot open it.
 */
const ERROR_MESSAGES = {
  ADMIN_NOT_CONFIGURED: "管理员配置尚未就绪。",
  ADMIN_CONFIG_BUSY: "配置正在保存，请稍后重试。",
  ADMIN_CONFIG_CONFLICT: "配置已更新，请重新读取后再保存。",
  ADMIN_CONFIG_STORAGE_UNAVAILABLE: "安全配置存储暂不可用。",
  ADMIN_CONFIG_INVALID: "模型配置无效，请检查输入。",
  ADMIN_INTERNAL_ERROR: "管理员请求暂时无法完成。",
} as const;

export type AdminErrorCode = keyof typeof ERROR_MESSAGES;

/** Only this fixed code/message vocabulary may cross the admin HTTP boundary. */
export class AdminHttpError extends Error {
  constructor(readonly status: number, readonly code: AdminErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "AdminHttpError";
  }
}

export interface AdminHeaderResponse {
  setHeader(name: string, value: string): void;
}

/** Can also run before the JSON body parser, so parser failures are never cached. */
export function setAdminResponseHeaders(response: AdminHeaderResponse): void {
  response.setHeader("Cache-Control", "private, no-store");
  response.setHeader("Pragma", "no-cache");
  response.setHeader("X-Content-Type-Options", "nosniff");
}

/** Backend failures are mapped by code only; raw messages and causes are never returned. */
export function safeAdminError(error: unknown): AdminHttpError {
  if (error instanceof AdminHttpError) return error;
  const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
  if (code === "ADMIN_CONFIG_CONFLICT" || code === "ADMIN_CONFIG_BUSY") return new AdminHttpError(409, code);
  if (code === "ADMIN_CONFIG_STORAGE_UNAVAILABLE") return new AdminHttpError(503, code);
  if (code === "ADMIN_CONFIG_INVALID") return new AdminHttpError(400, code);
  return new AdminHttpError(500, "ADMIN_INTERNAL_ERROR");
}
