#!/usr/bin/env node
// Collects the FFmpeg build actually installed on this host: version, configure flags, license line and, on
// Debian/Ubuntu, the ffmpeg and libav*/libsw*/libpostproc packages with their source packages and copyright files.
// It records facts only. It does not decide whether commercial distribution is allowed.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { hostname, platform, release } from "node:os";
import { pathToFileURL } from "node:url";

export function parseVersion(text) {
  const match = /^ffmpeg version (\S+)/m.exec(text);
  const libraries = {};
  for (const line of text.split(/\r?\n/)) {
    const lib = /^(lib\w+)\s+(\d+)\.\s*(\d+)\.\s*(\d+)/.exec(line.trim());
    if (lib) libraries[lib[1]] = `${lib[2]}.${lib[3]}.${lib[4]}`;
  }
  return { version: match ? match[1] : null, libraries };
}

export function parseConfigureFlags(text) {
  const start = text.indexOf("configuration:");
  if (start < 0) return [];
  return text.slice(start + "configuration:".length).split(/\s+/).map((flag) => flag.trim()).filter((flag) => flag.startsWith("--"));
}

/** License class implied by the configure flags. FFmpeg's own -L text is kept verbatim beside it. */
export function licenseClass(flags) {
  const has = (flag) => flags.includes(flag);
  if (has("--enable-nonfree")) return "nonfree (not redistributable)";
  if (has("--enable-gpl") && has("--enable-version3")) return "GPL v3 or later";
  if (has("--enable-gpl")) return "GPL v2 or later";
  if (has("--enable-version3")) return "LGPL v3 or later";
  return "LGPL v2.1 or later";
}

export function externalLibraries(flags) {
  return flags.filter((flag) => /^--enable-lib/.test(flag)).map((flag) => flag.slice("--enable-".length)).sort();
}

export function parseDpkgLines(text) {
  return text.split(/\r?\n/).filter(Boolean).map((line) => {
    const [name, version, source, status] = line.split("\t");
    return { name, version, source: source || name, installed: (status ?? "").includes("installed") };
  }).filter((item) => item.installed);
}

function run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.error || result.status !== 0) return null;
  return `${result.stdout}${result.stderr}`;
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function collect(ffmpeg = "ffmpeg") {
  const versionText = run(ffmpeg, ["-hide_banner", "-version"]);
  if (!versionText) return { ok: false, error: `${ffmpeg} is not runnable on this host` };
  const buildconf = run(ffmpeg, ["-hide_banner", "-buildconf"]) ?? "";
  const licenseText = (run(ffmpeg, ["-hide_banner", "-L"]) ?? "").trim();
  const flags = parseConfigureFlags(buildconf || versionText);
  const parsed = parseVersion(versionText);
  let packages = null;
  const dpkg = run("dpkg-query", ["-W", "-f", "${Package}\t${Version}\t${source:Package}\t${Status}\n",
    "ffmpeg", "libavcodec*", "libavformat*", "libavutil*", "libavfilter*", "libavdevice*", "libswscale*",
    "libswresample*", "libpostproc*"]);
  if (dpkg !== null) {
    packages = parseDpkgLines(dpkg).map((item) => {
      const copyright = `/usr/share/doc/${item.name}/copyright`;
      return { ...item, copyrightFile: existsSync(copyright) ? copyright : null,
        copyrightSha256: existsSync(copyright) ? sha256(copyright) : null };
    });
  }
  return {
    ok: true,
    schema: "ads.ffmpeg.sbom.v1",
    collectedAt: new Date().toISOString(),
    host: { hostname: hostname(), platform: platform(), release: release() },
    ffmpeg: { version: parsed.version, libraries: parsed.libraries, configureFlags: flags,
      licenseClassFromFlags: licenseClass(flags), externalLibraries: externalLibraries(flags), licenseText },
    packages,
    // Facts from this host only. Dependency licenses and commercial distribution still need a separate review.
    commercialDistributionReviewed: false,
  };
}

const invoked = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invoked) {
  const args = process.argv.slice(2);
  const outputIndex = args.indexOf("--output");
  const binIndex = args.indexOf("--ffmpeg");
  const result = collect(binIndex >= 0 ? args[binIndex + 1] : "ffmpeg");
  const text = `${JSON.stringify(result, null, 2)}\n`;
  if (outputIndex >= 0) writeFileSync(args[outputIndex + 1], text);
  else process.stdout.write(text);
  process.exitCode = result.ok ? 0 : 1;
}
