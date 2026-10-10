import { resolveApiUpstream } from "./api-upstream";

const UUID_TEXT = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FORWARDED = ["content-type", "content-length", "cache-control", "x-content-type-options", "content-disposition"];

export async function proxyEpisodeExport(
  request: Request,
  params: Promise<{ projectId: string; episodeId: string; assetId: string }>,
  leaf: "download" | "export-manifest",
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  const { projectId, episodeId, assetId } = await params;
  if (![projectId, episodeId, assetId].every((value) => UUID_TEXT.test(value))) {
    return jsonError(400, "VALIDATION_ERROR", "Route parameter must be a UUID");
  }
  const url = new URL(request.url);
  const expected = url.searchParams.get("expectedContentHash");
  if ([...url.searchParams.keys()].length !== 1 || expected == null || !/^[0-9a-f]{64}$/.test(expected)) {
    return jsonError(400, "VALIDATION_ERROR", "Request query is invalid");
  }
  const origin = resolveApiUpstream(process.env.NEXT_PUBLIC_API_BASE_URL);
  const upstreamPath = `/api/v1/projects/${projectId.toLowerCase()}/episodes/${episodeId.toLowerCase()}/composites/${assetId.toLowerCase()}/${leaf}?expectedContentHash=${expected}`;
  // The API checks the site session itself; this proxy only passes the browser cookie through, never grants access.
  const cookie = request.headers.get("cookie");
  const upstream = await fetchImpl(`${origin}${upstreamPath}`, { method: request.method, ...(cookie ? { headers: { cookie } } : {}) });
  const headers = new Headers();
  for (const name of FORWARDED) {
    const value = upstream.headers.get(name);
    if (!value) continue;
    if (name === "content-disposition" && !upstream.ok) continue;
    headers.set(name, value);
  }
  if (request.method === "HEAD") {
    await upstream.body?.cancel();
    return new Response(null, { status: upstream.status, headers });
  }
  const bytes = await upstream.arrayBuffer();
  return new Response(bytes, { status: upstream.status, headers });
}

function jsonError(status: number, code: string, message: string): Response {
  return Response.json({ error: { code, message, traceId: "web" } }, { status });
}
