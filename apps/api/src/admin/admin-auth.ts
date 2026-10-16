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
  ADMIN_CONFIG_KEY_FORMAT: "Claude API Key 的格式不受支持。请粘贴在 Claude Console（platform.claude.com）的 API keys 页面创建的完整密钥。没有保存任何内容。",
  ADMIN_CONFIG_KEY_KIND: "这是一种不能用于调用 Claude API 的凭据（例如 Claude Code 或订阅账号的登录令牌、Admin Key、浏览器会话或 JWT）。请改用 Claude Console 创建的 API Key。没有保存任何内容。",
  ADMIN_CONFIG_WORKSPACE_FORMAT: "Workspace ID 格式不正确，应为 Claude Console 工作区页面 ID 列中的 wrkspc_… 值。没有保存任何内容。",
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
