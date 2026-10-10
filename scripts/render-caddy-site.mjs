import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Renders infra/caddy/site.Caddyfile.template for one site. The output never contains basic_auth: the application
 * login replaces it. Prints to stdout; it does not write server files, reload Caddy or read credentials.
 */
const TEMPLATE = fileURLToPath(new URL("../infra/caddy/site.Caddyfile.template", import.meta.url));

export async function renderCaddySite({ site, upstream, tlsInternal = false }) {
  if (typeof site !== "string" || !/^[a-z0-9.-]+(:\d{2,5})?$/.test(site) || site.startsWith(".") || site.includes("..")) {
    throw new Error("Site must be a host name, optionally with a port (no scheme, path or wildcard).");
  }
  // The Web upstream is local to the server: the application must never be reached around the proxy's host.
  if (typeof upstream !== "string" || !/^(127\.0\.0\.1|localhost|\[::1\]):\d{2,5}$/.test(upstream)) {
    throw new Error("Upstream must be a loopback host:port.");
  }
  const template = await readFile(TEMPLATE, "utf8");
  const output = template
    .replace("{{SITE_ADDRESS}}", site)
    .replace("{{TLS_LINE}}", tlsInternal ? "\ttls internal\n\n" : "")
    .replace("{{WEB_UPSTREAM}}", upstream);
  if (/\{\{[A-Z_]+\}\}/.test(output)) throw new Error("Unfilled template placeholder.");
  if (/^\s*(basic_?auth|basicauth)\b/im.test(output)) throw new Error("The site block must not contain basic_auth.");
  return output;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const value = (name) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
  try {
    process.stdout.write(await renderCaddySite({ site: value("--site"), upstream: value("--upstream"), tlsInternal: args.includes("--tls-internal") }));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "Failed."}\nUsage: node scripts/render-caddy-site.mjs --site drama.example.test --upstream 127.0.0.1:3000 [--tls-internal]\n`);
    process.exitCode = 1;
  }
}
