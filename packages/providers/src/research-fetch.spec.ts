import { describe, expect, it } from "vitest";
import { blockedAddress, createResearchFetcher, urlProblem } from "./research-fetch";

const HOSTS = ["support.oceanengine.com"];

describe("research page reads", () => {
  it("refuses http, other ports, credentials, IP literals and hosts outside the allowlist before any lookup", () => {
    expect(urlProblem("http://support.oceanengine.com/a", HOSTS)).not.toBeNull();
    expect(urlProblem("https://support.oceanengine.com:8443/a", HOSTS)).not.toBeNull();
    expect(urlProblem("https://u:p@support.oceanengine.com/a", HOSTS)).not.toBeNull();
    expect(urlProblem("https://169.254.169.254/latest/meta-data", HOSTS)).not.toBeNull();
    expect(urlProblem("https://[::1]/", HOSTS)).not.toBeNull();
    expect(urlProblem("https://localhost/", HOSTS)).not.toBeNull();
    expect(urlProblem("https://evil.example/", HOSTS)).not.toBeNull();
    expect(urlProblem("https://support.oceanengine.com/a", HOSTS)).toBeNull();
  });

  it("blocks loopback, private, link-local, shared, metadata and mapped addresses", () => {
    for (const address of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:10.0.0.1"]) {
      expect(blockedAddress(address)).toBe(true);
    }
    expect(blockedAddress("106.55.24.179")).toBe(false);
  });

  it("decodes every IPv6 form that carries an IPv4 address before judging it", () => {
    for (const address of ["::ffff:a00:1", "::ffff:7f00:1", "::ffff:a9fe:a9fe", "0:0:0:0:0:ffff:7f00:0001", "::ffff:127.0.0.1",
      "::7f00:1", "64:ff9b::a00:1", "2002:a00:1::", "fec0::1", "ff02::1", "2001:db8::1"]) {
      expect(blockedAddress(address), address).toBe(true);
    }
    expect(blockedAddress("::ffff:6a37:18b3")).toBe(false); // 106.55.24.179
    expect(blockedAddress("2400:3200::1")).toBe(false);
  });

  it("an allowed host resolving to a private address is never requested", async () => {
    let requested = 0;
    const fetch = createResearchFetcher({ allowedHosts: HOSTS, lookup: async () => [{ address: "10.0.0.5", family: 4 }],
      get: async () => { requested += 1; return { status: 200, contentType: "text/html", body: "" }; } });
    const [page] = await fetch(["https://support.oceanengine.com/a"]);
    expect(page).toMatchObject({ status: "blocked", text: "" });
    expect(requested).toBe(0);
  });

  it("one per-URL deadline covers a DNS lookup that never answers", async () => {
    let requested = 0;
    const fetch = createResearchFetcher({ allowedHosts: HOSTS, timeoutMs: 50, lookup: () => new Promise(() => undefined),
      get: async () => { requested += 1; return { status: 200, contentType: "text/html", body: "" }; } });
    const started = Date.now();
    const [page] = await fetch(["https://support.oceanengine.com/a"]);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(page).toMatchObject({ status: "unreadable" });
    expect(requested).toBe(0);
  });

  it("the same deadline stops a response that keeps trickling", async () => {
    const fetch = createResearchFetcher({ allowedHosts: HOSTS, timeoutMs: 50, lookup: async () => [{ address: "203.0.113.10", family: 4 }],
      get: () => new Promise(() => undefined) });
    const started = Date.now();
    const [page] = await fetch(["https://support.oceanengine.com/a"]);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(page).toMatchObject({ status: "unreadable" });
  });

  it("connects to the checked address, never follows redirects and records script shells as unread", async () => {
    const used: string[] = [];
    const answers = [
      { status: 302, contentType: "text/html", body: "" },
      { status: 200, contentType: "text/html", body: "<html><head><title>壳</title></head><body><div id=app></div><script>x()</script></body></html>" },
      { status: 200, contentType: "text/html", body: `<title>说明</title><meta property="article:published_time" content="2026-09-01T00:00:00Z"><p>${"公开说明正文。".repeat(20)}</p>` },
    ];
    const fetch = createResearchFetcher({ allowedHosts: HOSTS, lookup: async () => [{ address: "203.0.113.10", family: 4 }],
      get: async (_url, address) => { used.push(address); return answers.shift()!; } });
    const pages = await fetch(["https://support.oceanengine.com/1", "https://support.oceanengine.com/2", "https://support.oceanengine.com/3"]);
    expect(used).toEqual(["203.0.113.10", "203.0.113.10", "203.0.113.10"]);
    expect(pages.map((page) => page.status)).toEqual(["blocked", "unreadable", "read"]);
    expect(pages[2]!.publishedAt).toBe("2026-09-01T00:00:00.000Z");
    expect(pages[1]!.text).toBe("");
  });
});
