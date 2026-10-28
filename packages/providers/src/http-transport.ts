/**
 * Provider-neutral HTTP pieces of the writing adapters: the transport seam, a fetch transport that never follows a
 * redirect and stops reading at a size limit, strict UTF-8 decoding and secret redaction. Moved here unchanged from the
 * retired Qwen module so OpenAI and Claude keep exactly the same safety rules.
 */
export const WRITING_HTTP_MAX_RESPONSE_BYTES = 1_048_576;

export class ResponseBodyError extends Error {
  constructor(readonly code: "response_too_large" | "invalid_utf8") {
    super(code === "response_too_large" ? "The response exceeded the size limit and was stopped." : "The response was not strict UTF-8.");
    this.name = "ResponseBodyError";
  }
}

export interface TransportRequest {
  url: string;
  method: "POST";
  headers: Record<string, string>;
  body: string;
  signal: AbortSignal;
}

export interface TransportResponse {
  status: number;
  headers: { get(name: string): string | null };
  body: Uint8Array | null;
}

export type WritingTransport = (request: TransportRequest) => Promise<TransportResponse>;

export function redactSecret(text: string, secret: string | null): string {
  if (!secret || secret.length === 0 || !text.includes(secret)) return text;
  return text.split(secret).join("[redacted]");
}

export function decodeResponseBytes(bytes: Uint8Array | null, maxBytes: number): string {
  if (!bytes || bytes.byteLength === 0) return "";
  if (bytes.byteLength > maxBytes) throw new ResponseBodyError("response_too_large");
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new ResponseBodyError("invalid_utf8");
  }
}

async function readLimited(body: ReadableStream<Uint8Array> | null, maxBytes: number): Promise<Uint8Array> {
  if (!body) return new Uint8Array();
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new ResponseBodyError("response_too_large");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

/**
 * The only network transport the API wires. One fetch per call: no retry, redirects are reported (status 0 or 3xx)
 * and never followed, and the body is read up to the limit.
 */
export function createFetchTransport(fetchImpl: typeof fetch = globalThis.fetch, maxBytes = WRITING_HTTP_MAX_RESPONSE_BYTES): WritingTransport {
  return async (request) => {
    const response = await fetchImpl(request.url, {
      method: "POST",
      headers: request.headers,
      body: request.body,
      redirect: "manual",
      signal: request.signal,
    });
    if (response.status === 0 || (response.status >= 300 && response.status < 400)) {
      await response.body?.cancel();
      return { status: response.status, headers: response.headers, body: null };
    }
    return { status: response.status, headers: response.headers, body: await readLimited(response.body, maxBytes) };
  };
}
