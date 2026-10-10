import { withSession } from "./site-session";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly detail: string,
  ) {
    super(detail);
  }
}

export interface WriteRequest {
  path: string;
  body: unknown;
  idempotencyKey: string;
  ifMatch?: number;
}

export interface WriteResult<T> {
  status: number;
  body: T;
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export class StudioClient {
  constructor(
    private readonly fetchImpl?: FetchLike,
    private readonly prefix = "/api/v1",
  ) {}

  /** options.signal (optional) cancels the request; without it the call is unchanged. */
  async get<T>(path: string, options?: { signal?: AbortSignal }): Promise<T> {
    const response = await this.request(`${this.prefix}${path}`, {
      method: "GET",
      headers: { Accept: "application/json" },
      ...(options?.signal ? { signal: options.signal } : {}),
    });
    return parseBody<T>(response);
  }

  async postJson<T>(path: string, body: unknown): Promise<T> {
    const response = await this.request(`${this.prefix}${path}`, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return parseBody<T>(response);
  }

  async write<T>(request: WriteRequest): Promise<WriteResult<T>> {
    const headers: Record<string, string> = {
      Accept: "application/json",
      "Content-Type": "application/json",
      "Idempotency-Key": request.idempotencyKey,
    };
    if (request.ifMatch !== undefined) headers["If-Match"] = String(request.ifMatch);
    const response = await this.request(`${this.prefix}${request.path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(stripWorkspace(request.body)),
    });
    const body = await parseBody<T>(response);
    return { status: response.status, body };
  }

  async readAttachment(path: string, accept: string): Promise<
    | { ok: true; blob: Blob; filename: string; contentType: string }
    | { ok: false; message: string; refresh: boolean }
  > {
    let response: Response;
    try {
      response = await this.request(`${this.prefix}${path}`, {
        method: "GET",
        headers: { Accept: accept },
      });
    } catch {
      return { ok: false, message: "下载没有完成", refresh: false };
    }
    const contentType = response.headers.get("content-type") ?? "";
    const disposition = response.headers.get("content-disposition") ?? "";
    const matchesType = contentType.toLowerCase().includes(accept);
    const attachment = disposition.toLowerCase().includes("attachment");
    if (!response.ok || !matchesType || !attachment) {
      const text = await response.text();
      return { ok: false, message: attachmentMessage(text, response.ok), refresh: !response.ok };
    }
    return {
      ok: true,
      blob: await response.blob(),
      filename: filenameFromDisposition(disposition),
      contentType,
    };
  }

  private request(input: string, init?: RequestInit): Promise<Response> {
    // Writes carry the session CSRF token next to Idempotency-Key and If-Match; an ended session goes to /login.
    return withSession(this.fetchImpl ?? globalThis.fetch.bind(globalThis))(input, init);
  }
}

function filenameFromDisposition(value: string): string {
  const match = /filename="([A-Za-z0-9._-]+)"/.exec(value);
  return match?.[1] ?? "episode-export";
}

function attachmentMessage(text: string, ok: boolean): string {
  try {
    const parsed: unknown = text.length === 0 ? null : JSON.parse(text);
    if (parsed && typeof parsed === "object" && "error" in parsed) {
      const message = (parsed as { error?: { message?: string } }).error?.message;
      if (message) return message;
    }
  } catch {
    return ok ? "下载内容与成片不一致" : "下载没有完成";
  }
  return ok ? "下载内容与成片不一致" : "下载没有完成";
}

function stripWorkspace(body: unknown): unknown {
  if (!body || typeof body !== "object" || Array.isArray(body)) return body;
  if (!("workspaceId" in body)) return body;
  const { workspaceId: _workspaceId, ...rest } = body as Record<string, unknown>;
  return rest;
}

async function parseBody<T>(response: Response): Promise<T> {
  const text = await response.text();
  const parsed: unknown = text.length === 0 ? null : JSON.parse(text);
  if (!response.ok) {
    const error = parsed && typeof parsed === "object" && "error" in parsed ? (parsed as { error?: { code?: string; message?: string } }).error : undefined;
    throw new ApiError(response.status, error?.code ?? "REQUEST_FAILED", error?.message ?? `HTTP ${response.status}`);
  }
  return parsed as T;
}
