const DEFAULT_API_ORIGIN = "http://127.0.0.1:3001";

export function resolveApiUpstream(value: string | undefined): string {
  const raw = value === undefined || value.trim().length === 0 ? DEFAULT_API_ORIGIN : value.trim();
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("NEXT_PUBLIC_API_BASE_URL is not a valid absolute URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("NEXT_PUBLIC_API_BASE_URL must use http or https");
  }
  if (url.username.length > 0 || url.password.length > 0) {
    throw new Error("NEXT_PUBLIC_API_BASE_URL must not include credentials");
  }
  if (url.search.length > 0 || url.hash.length > 0) {
    throw new Error("NEXT_PUBLIC_API_BASE_URL must not include a query or hash");
  }
  return url.origin;
}
