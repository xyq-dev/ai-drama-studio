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
  /** Per-URL deadline covering DNS and the request; RESEARCH_FETCH_TIMEOUT_MS by default (tests shorten it). */
  timeoutMs?: number;
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

/** The eight 16-bit groups of an IPv6 address in any textual form (zero compression, embedded IPv4), or null. */
export function ipv6Groups(address: string): number[] | null {
  let text = address.toLowerCase().replace(/%.*$/u, "");
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/u.exec(text)?.[1];
  if (dotted) {
    const parts = dotted.split(".").map(Number);
    if (parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null;
    text = `${text.slice(0, -dotted.length)}${((parts[0]! << 8) | parts[1]!).toString(16)}:${((parts[2]! << 8) | parts[3]!).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0 || (halves.length === 1 && head.length !== 8)) return null;
  const groups = [...head, ...Array<string>(fill).fill("0"), ...tail].map((group) => /^[0-9a-f]{1,4}$/u.test(group) ? parseInt(group, 16) : NaN);
  return groups.length === 8 && groups.every((group) => Number.isInteger(group)) ? groups : null;
}

/**
 * True for every address a server-side read must never reach. IPv6 is decoded to its groups first, so every textual
 * form of an IPv4-mapped (::ffff:0:0/96), IPv4-compatible (::/96) or NAT64 (64:ff9b::/96) address is judged by the IPv4
 * address it carries.
 */
export function blockedAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return ipv4Blocked(address);
  if (family !== 6) return true;
  const groups = ipv6Groups(address);
  if (!groups) return true;
  const embedded = () => `${String(groups[6]! >> 8)}.${String(groups[6]! & 255)}.${String(groups[7]! >> 8)}.${String(groups[7]! & 255)}`;
  const zeros = (count: number) => groups.slice(0, count).every((group) => group === 0);
  if (zeros(5) && groups[5] === 0xffff) return ipv4Blocked(embedded());
  if (zeros(6)) return true; // ::, ::1 and the deprecated IPv4-compatible block
  if (groups[0] === 0x64 && groups[1] === 0xff9b) return true; // NAT64 can reach any IPv4 address
  const first = groups[0]!;
  return (first & 0xfe00) === 0xfc00 // unique local fc00::/7
    || (first & 0xffc0) === 0xfe80 // link-local fe80::/10
    || (first & 0xffc0) === 0xfec0 // site-local fec0::/10
    || (first & 0xff00) === 0xff00 // multicast
    || (first === 0x2001 && groups[1] === 0x0db8) // documentation
    || first === 0x2002; // 6to4 can embed private IPv4
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
    // An absolute deadline: the socket timeout above only measures inactivity, and a trickling server must not hold
    // the stage open past timeoutMs.
    const deadline = setTimeout(() => req.destroy(new Error("timeout")), timeoutMs);
    req.on("close", () => clearTimeout(deadline));
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

/** Rejects when the work has not settled within ms (the work itself is abandoned, never awaited further). */
function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("timeout")), ms); });
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}

/** Reads each URL once. Failures are recorded as what they are; nothing is retried. */
export function createResearchFetcher(deps: ResearchFetchDeps): (urls: readonly string[]) => Promise<FetchedPage[]> {
  const timeoutMs = deps.timeoutMs ?? RESEARCH_FETCH_TIMEOUT_MS;
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
      // One deadline per URL, DNS included: the lookup and the request share RESEARCH_FETCH_TIMEOUT_MS.
      const startedAt = Date.now();
      let addresses: Array<{ address: string; family: number }>;
      try {
        addresses = await withDeadline(lookup(url.hostname), timeoutMs);
      } catch {
        pages.push({ ...base, status: "unreadable", note: "域名解析失败或超时，没有读取。" });
        continue;
      }
      if (addresses.length === 0 || addresses.some((item) => blockedAddress(item.address))) {
        pages.push({ ...base, status: "blocked", note: "域名解析到内网、本机或保留地址，已拒绝读取。" });
        continue;
      }
      const target = addresses[0]!;
      try {
        const remaining = Math.max(1, timeoutMs - (Date.now() - startedAt));
        const response = await withDeadline(get(url, target.address, target.family, remaining, RESEARCH_FETCH_MAX_BYTES), remaining);
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
