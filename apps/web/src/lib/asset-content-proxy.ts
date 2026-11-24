import { resolveApiUpstream } from "./api-upstream";

export async function proxyAssetContent(
  request: Request,
  params: Promise<{ assetId: string }>,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  const { assetId } = await params;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(assetId)) {
    return new Response(null, { status: 400 });
  }
  const origin = resolveApiUpstream(process.env.NEXT_PUBLIC_API_BASE_URL);
  const headers = new Headers();
  for (const name of ["range", "if-range"]) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  // The API checks the site session itself; this proxy only passes the browser cookie through, never grants access.
  const cookie = request.headers.get("cookie");
  if (cookie) headers.set("cookie", cookie);
  const upstream = await fetchImpl(`${origin}/api/v1/assets/${assetId.toLowerCase()}/content`, {
    method: request.method,
    headers,
    signal: request.signal,
  });
  const responseHeaders = new Headers();
  for (const name of ["content-type", "content-length", "content-range", "accept-ranges", "etag", "cache-control", "x-content-type-options"]) {
    const value = upstream.headers.get(name);
    if (value) responseHeaders.set(name, value);
  }
  if (request.method === "HEAD") {
    await upstream.body?.cancel();
    return new Response(null, { status: upstream.status, headers: responseHeaders });
  }
  return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
}
