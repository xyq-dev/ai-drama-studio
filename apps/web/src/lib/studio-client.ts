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
    private readonly fetchImpl: FetchLike = fetch,
    private readonly prefix = "/api/v1",
  ) {}

  async get<T>(path: string): Promise<T> {
    const response = await this.fetchImpl(`${this.prefix}${path}`, {
      method: "GET",
      headers: { Accept: "application/json" },
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
    const response = await this.fetchImpl(`${this.prefix}${request.path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(stripWorkspace(request.body)),
    });
    const body = await parseBody<T>(response);
    return { status: response.status, body };
  }
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
