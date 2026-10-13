import assert from "node:assert/strict";
import { test } from "node:test";
import { renderCaddySite } from "./render-caddy-site.mjs";

test("renders one site block without basic_auth, proxying only to the loopback Web server", async () => {
  const output = await renderCaddySite({ site: "drama.example.test", upstream: "127.0.0.1:3000" });
  assert.match(output, /^drama\.example\.test \{$/m);
  assert.match(output, /^\treverse_proxy 127\.0\.0\.1:3000$/m);
  assert.equal(/basic_?auth|basicauth/i.test(output.replace(/^#.*$/gm, "")), false);
  assert.equal(/^\s*(basic_?auth|basicauth)\b/im.test(output), false);
  assert.equal(output.includes("tls internal"), false);
  assert.equal((output.match(/reverse_proxy/g) ?? []).length, 1);
  assert.match(output, /request_header -X-Forwarded-User/);
});

test("adds tls internal only when asked (isolated tests)", async () => {
  assert.match(await renderCaddySite({ site: "localhost:8443", upstream: "127.0.0.1:3210", tlsInternal: true }), /^\ttls internal$/m);
});

test("refuses public upstreams and malformed sites", async () => {
  for (const input of [
    { site: "drama.example.test", upstream: "10.0.0.5:3000" }, { site: "drama.example.test", upstream: "example.com:3000" },
    { site: "https://drama.example.test", upstream: "127.0.0.1:3000" }, { site: "*.example.test", upstream: "127.0.0.1:3000" },
    { site: "drama.example.test/path", upstream: "127.0.0.1:3000" }, { site: "drama.example.test {\n basic_auth", upstream: "127.0.0.1:3000" },
  ]) await assert.rejects(renderCaddySite(input), undefined, JSON.stringify(input));
});
