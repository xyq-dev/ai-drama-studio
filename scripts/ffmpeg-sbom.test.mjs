import assert from "node:assert/strict";
import test from "node:test";
import { externalLibraries, licenseClass, parseConfigureFlags, parseDpkgLines, parseVersion } from "./ffmpeg-sbom.mjs";

// Shape of `ffmpeg -version` / `-buildconf` from the Ubuntu 7:6.1.1-3ubuntu5 package the M4 CI installs, shortened.
const VERSION = `ffmpeg version 6.1.1-3ubuntu5 Copyright (c) 2000-2023 the FFmpeg developers
built with gcc 13 (Ubuntu 13.2.0-23ubuntu3)
configuration: --prefix=/usr --extra-version=3ubuntu5 --enable-gpl --disable-stripping --enable-libx264 --enable-libmp3lame --enable-shared
libavutil      58. 29.100 / 58. 29.100
libavcodec     60. 31.102 / 60. 31.102
libswresample   4. 12.100 /  4. 12.100`;

test("parses version, library versions and configure flags", () => {
  const parsed = parseVersion(VERSION);
  assert.equal(parsed.version, "6.1.1-3ubuntu5");
  assert.deepEqual(parsed.libraries, { libavutil: "58.29.100", libavcodec: "60.31.102", libswresample: "4.12.100" });
  const flags = parseConfigureFlags(VERSION);
  assert.ok(flags.includes("--enable-gpl"));
  assert.ok(!flags.some((flag) => flag.startsWith("libav")));
  assert.deepEqual(externalLibraries(flags), ["libmp3lame", "libx264"]);
});

test("derives the license class from the flags, flagging nonfree as not redistributable", () => {
  assert.equal(licenseClass(["--enable-gpl"]), "GPL v2 or later");
  assert.equal(licenseClass(["--enable-gpl", "--enable-version3"]), "GPL v3 or later");
  assert.equal(licenseClass(["--enable-version3"]), "LGPL v3 or later");
  assert.equal(licenseClass([]), "LGPL v2.1 or later");
  assert.equal(licenseClass(["--enable-gpl", "--enable-nonfree"]), "nonfree (not redistributable)");
});

test("keeps only installed dpkg rows and falls back to the package name as its source", () => {
  const rows = parseDpkgLines("ffmpeg\t7:6.1.1-3ubuntu5\tffmpeg\tinstall ok installed\nlibavcodec60\t7:6.1.1-3ubuntu5\t\tinstall ok installed\nlibold\t1\t\tdeinstall ok config-files\n");
  assert.deepEqual(rows, [
    { name: "ffmpeg", version: "7:6.1.1-3ubuntu5", source: "ffmpeg", installed: true },
    { name: "libavcodec60", version: "7:6.1.1-3ubuntu5", source: "libavcodec60", installed: true },
  ]);
});
