import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:https";
import type { AddressInfo } from "node:net";
import { getDefaultAutoSelectFamily, setDefaultAutoSelectFamily } from "node:net";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { blockedAddress, createResearchFetcher, researchHttpsGet, urlProblem } from "./research-fetch";

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

// The real node:https path, not an injected get: a local TLS server for research.test (a name that never resolves), a
// test-only CA, and the connection pinned to 127.0.0.1. This is what runs in production when reading is switched on.
describe("research page reads over node:https", () => {
  const fixtures = join(__dirname, "test-fixtures", "research-tls");
  const ca = readFileSync(join(fixtures, "ca.crt"), "utf8");
  const servers: Server[] = [];
  const autoSelect = getDefaultAutoSelectFamily();

  afterEach(async () => {
    setDefaultAutoSelectFamily(autoSelect);
    await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => {
      server.closeAllConnections();
      server.close(resolve);
    })));
  });

  async function serve(handler: (request: IncomingMessage, response: ServerResponse) => void): Promise<number> {
    const server = createServer({ key: readFileSync(join(fixtures, "server.key")), cert: readFileSync(join(fixtures, "server.crt")) }, handler);
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return (server.address() as AddressInfo).port;
  }

  it("reads through the pinned address with the address family auto-selection on and off (Node calls lookup with all: true)", async () => {
    const port = await serve((request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<p>${request.headers.host ?? ""}</p>`);
    });
    for (const auto of [true, false]) {
      setDefaultAutoSelectFamily(auto);
      const answer = await researchHttpsGet(new URL(`https://research.test:${String(port)}/page`), "127.0.0.1", 4, 2_000, 1024, { ca });
      expect(answer, `autoSelectFamily=${String(auto)}`).toEqual({ status: 200, contentType: "text/html; charset=utf-8", body: `<p>research.test:${String(port)}</p>` });
    }
  });

  it("verifies the certificate for the host name, never for the pinned address", async () => {
    const port = await serve((_request, response) => response.end("x"));
    await expect(researchHttpsGet(new URL(`https://other.test:${String(port)}/`), "127.0.0.1", 4, 2_000, 1024, { ca })).rejects.toThrow(/other\.test|altnames/);
    // Without the test CA the same server is untrusted: verification is never switched off.
    await expect(researchHttpsGet(new URL(`https://research.test:${String(port)}/`), "127.0.0.1", 4, 2_000, 1024)).rejects.toThrow();
  });

  it("returns a redirect as it is, without following it", async () => {
    let hits = 0;
    const port = await serve((_request, response) => {
      hits += 1;
      response.writeHead(302, { location: "https://research.test/elsewhere" });
      response.end();
    });
    const answer = await researchHttpsGet(new URL(`https://research.test:${String(port)}/`), "127.0.0.1", 4, 2_000, 1024, { ca });
    expect(answer.status).toBe(302);
    expect(hits).toBe(1);
  });

  it("an absolute deadline stops a response that keeps trickling, and the size cap stops a large one", async () => {
    const port = await serve((request, response) => {
      response.writeHead(200, { "content-type": "text/plain" });
      if (request.url === "/large") {
        response.end("x".repeat(4096));
        return;
      }
      const timer = setInterval(() => response.write("x"), 20);
      response.on("close", () => clearInterval(timer));
    });
    const started = Date.now();
    await expect(researchHttpsGet(new URL(`https://research.test:${String(port)}/slow`), "127.0.0.1", 4, 300, 1024 * 1024, { ca })).rejects.toThrow("timeout");
    expect(Date.now() - started).toBeLessThan(2_000);
    await expect(researchHttpsGet(new URL(`https://research.test:${String(port)}/large`), "127.0.0.1", 4, 2_000, 1024, { ca })).rejects.toThrow("response_too_large");
  });
});
