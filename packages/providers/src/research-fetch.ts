import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import type { FetchedPage } from "@ai-drama/domain";

/**
 * Reads public pages for the research snapshot of automatic creation. Only https on port 443, only hosts on the
 * server's allowlist, never an IP literal, never an address that resolves to a loopback, private, link-local,
 * shared, multicast or metadata range; the connection is pinned to the checked address (no DNS rebinding), redirects
 * are never followed, and size and time are capped. What comes back is untrusted text: it is quoted as data only.
 */

export const RESEARCH_FETCH_TIMEOUT_MS = 8_000;
export const RESEARCH_FETCH_MAX_BYTES = 512 * 1024;

export interface ResearchFetchDeps {
  allowedHosts: readonly string[];
  lookup?: (host: string) => Promise<Array<{ address: string; family: number }>>;
  get?: (url: URL, address: string, family: number, timeoutMs: number, maxBytes: number) => Promise<{ status: number; contentType: string; body: string }>;
  clock?: () => Date;
}

function ipv4Blocked(address: string): boolean {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b] = parts as [number, number, number, number];
  return a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 192 && b === 0)
    || (a === 198 && (b === 18 || b === 19));
}

/** True for every address a server-side read must never reach. */
export function blockedAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return ipv4Blocked(address);
  if (family !== 6) return true;
  const lower = address.toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower)?.[1];
  if (mapped) return ipv4Blocked(mapped);
  return lower === "::" || lower === "::1" || lower.startsWith("fc") || lower.startsWith("fd") || lower.startsWith("fe8")
    || lower.startsWith("fe9") || lower.startsWith("fea") || lower.startsWith("feb") || lower.startsWith("ff")
    || lower.startsWith("fd00:ec2") || lower.startsWith("64:ff9b");
}

/** Why a URL may not be read, or null. */
export function urlProblem(raw: string, allowedHosts: readonly string[]): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "地址无效";
  }
  if (url.protocol !== "https:") return "只读取 https 地址";
  if (url.username || url.password) return "地址不能包含账号信息";
  if (url.port !== "" && url.port !== "443") return "只读取 443 端口";
  const host = url.hostname.toLowerCase();
  if (isIP(host.replace(/^\[|\]$/g, "")) !== 0) return "不读取 IP 地址";
  if (!allowedHosts.map((item) => item.toLowerCase()).includes(host)) return "域名不在服务端允许读取的列表中";
  return null;
}

function defaultGet(url: URL, address: string, family: number, timeoutMs: number, maxBytes: number) {
  return new Promise<{ status: number; contentType: string; body: string }>((resolve, reject) => {
    const req = httpsRequest(url, {
      method: "GET",
      headers: { Accept: "text/html,text/plain;q=0.9", "User-Agent": "ai-drama-studio-research/1" },
      // Pinned to the address that was checked; the certificate is still verified for the host name.
      lookup: (_host, _options, callback) => callback(null, address, family),
      servername: url.hostname,
      timeout: timeoutMs,
    }, (response) => {
      const chunks: Buffer[] = [];
      let size = 0;
      response.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > maxBytes) {
          req.destroy(new Error("response_too_large"));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => resolve({ status: response.statusCode ?? 0, contentType: String(response.headers["content-type"] ?? ""),
        body: Buffer.concat(chunks).toString("utf8") }));
      response.on("error", reject);
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.end();
  });
}

function pageText(html: string): { title: string | null; text: string; publishedAt: string | null } {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.replace(/\s+/g, " ").trim() || null;
  const published = /(?:article:published_time|datePublished)["']?\s*(?:content=|:)\s*["']([^"']{8,40})["']/i.exec(html)?.[1] ?? null;
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const parsed = published && Number.isFinite(Date.parse(published)) ? new Date(published).toISOString() : null;
  return { title, text, publishedAt: parsed };
}

/** Reads each URL once. Failures are recorded as what they are; nothing is retried. */
export function createResearchFetcher(deps: ResearchFetchDeps): (urls: readonly string[]) => Promise<FetchedPage[]> {
  const lookup = deps.lookup ?? (async (host: string) => dnsLookup(host, { all: true, verbatim: true }));
  const get = deps.get ?? defaultGet;
  return async (urls) => {
    const pages: FetchedPage[] = [];
    for (const raw of urls) {
      const fetchedAt = (deps.clock ? deps.clock() : new Date()).toISOString();
      const base = { url: raw, title: null, text: "", publishedAt: null, fetchedAt };
      const problem = urlProblem(raw, deps.allowedHosts);
      if (problem) {
        pages.push({ ...base, status: "blocked", note: `没有读取：${problem}。` });
        continue;
      }
      const url = new URL(raw);
      let addresses: Array<{ address: string; family: number }>;
      try {
        addresses = await lookup(url.hostname);
      } catch {
        pages.push({ ...base, status: "unreadable", note: "域名解析失败，没有读取。" });
        continue;
      }
      if (addresses.length === 0 || addresses.some((item) => blockedAddress(item.address))) {
        pages.push({ ...base, status: "blocked", note: "域名解析到内网、本机或保留地址，已拒绝读取。" });
        continue;
      }
      const target = addresses[0]!;
      try {
        const response = await get(url, target.address, target.family, RESEARCH_FETCH_TIMEOUT_MS, RESEARCH_FETCH_MAX_BYTES);
        if (response.status >= 300 && response.status < 400) {
          pages.push({ ...base, status: "blocked", note: `页面返回重定向（${String(response.status)}），没有跟随。` });
          continue;
        }
        if (response.status === 401 || response.status === 403) {
          pages.push({ ...base, status: "login_required", note: `页面需要登录或拒绝访问（${String(response.status)}）。` });
          continue;
        }
        if (response.status < 200 || response.status >= 300 || !/text\/(html|plain)/i.test(response.contentType)) {
          pages.push({ ...base, status: "unreadable", note: `页面不可读（状态 ${String(response.status)}，类型 ${response.contentType || "未知"}）。` });
          continue;
        }
        const parsed = pageText(response.body);
        if (parsed.text.length < 80) {
          const login = /登录|login|sign in/i.test(parsed.text);
          pages.push({ ...base, title: parsed.title, publishedAt: parsed.publishedAt, status: login ? "login_required" : "unreadable",
            note: login ? "页面只显示登录提示，没有读到正文。" : "页面为脚本渲染或几乎没有文字，没有读到正文。" });
          continue;
        }
        pages.push({ ...base, title: parsed.title, text: parsed.text, publishedAt: parsed.publishedAt, status: "read",
          note: `读取了公开页面的文字（不含图片、视频、音频；最多 ${String(RESEARCH_FETCH_MAX_BYTES / 1024)} KB）。${parsed.publishedAt ? "" : "页面没有标明发布日期，无法判断时效。"}` });
      } catch (error) {
        const tooLarge = error instanceof Error && error.message === "response_too_large";
        pages.push({ ...base, status: "unreadable", note: tooLarge ? "页面超过大小上限，没有读取。" : "读取失败或超时。" });
      }
    }
    return pages;
  };
}
