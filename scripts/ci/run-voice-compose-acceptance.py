#!/usr/bin/env python3
"""Strict, offline CJK composition acceptance with durable CI evidence.

This runner only loads the committed voice composition unittest module. It never
connects to a database, calls a model/provider, or installs dependencies. CI must
provide FFmpeg, ffprobe and the real Noto Sans CJK SC font before invoking it.
"""

from __future__ import annotations

import hashlib
import importlib.util
import json
import math
import os
import re
import struct
import subprocess
import sys
import unittest
from datetime import datetime, timezone
from pathlib import Path
from typing import TextIO

SUMMARY_SCHEMA = "voice.compose.ci.summary.v1"
EVIDENCE_SCHEMA = "voice.compose.test.evidence.v1"
MODULE_NAME = "test_voice_compose"
REQUIRED_TEST_ID = f"{MODULE_NAME}.VoiceComposeTests.test_render_sentences_pauses_ducking"
HASH = re.compile(r"[a-f0-9]{64}\Z")
ARTIFACT_NAMES = ("voice-proof.png", "voice-proof.json", "voice-output.mp4")
MAX_MP4_BYTES = 64 * 1024 * 1024


class AcceptanceFailure(Exception):
    pass


class EvidenceResult(unittest.TextTestResult):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.success_ids: list[str] = []

    def addSuccess(self, test):  # noqa: N802 -- unittest's standard callback name
        super().addSuccess(test)
        self.success_ids.append(test.id())


def load_voice_suite(repo_root: Path) -> unittest.TestSuite:
    source = repo_root / "services/media-worker/src"
    tests = repo_root / "services/media-worker/tests"
    for directory in (source, tests):
        if str(directory) not in sys.path:
            sys.path.insert(0, str(directory))
    # Explicitly load one file, rather than discovering other test modules and
    # possibly triggering unrelated setup or changing the scope of acceptance.
    spec = importlib.util.spec_from_file_location(MODULE_NAME, tests / "test_voice_compose.py")
    if spec is None or spec.loader is None:
        raise AcceptanceFailure("The committed voice composition test module cannot be loaded")
    module = importlib.util.module_from_spec(spec)
    sys.modules[MODULE_NAME] = module
    spec.loader.exec_module(module)
    return unittest.defaultTestLoader.loadTestsFromModule(module)


def execute_tests(repo_root: Path, stream: TextIO) -> EvidenceResult:
    suite = load_voice_suite(repo_root)
    return unittest.TextTestRunner(stream=stream, verbosity=2, resultclass=EvidenceResult).run(suite)


def result_details(result: EvidenceResult) -> dict:
    return {
        "testsRun": result.testsRun,
        "successIds": result.success_ids,
        "failures": [{"id": test.id(), "traceback": trace} for test, trace in result.failures],
        "errors": [{"id": test.id(), "traceback": trace} for test, trace in result.errors],
        "skipped": [{"id": test.id(), "reason": reason} for test, reason in result.skipped],
        "expectedFailures": [{"id": test.id(), "traceback": trace} for test, trace in result.expectedFailures],
        "unexpectedSuccessIds": [test.id() for test in result.unexpectedSuccesses],
        "requiredTestSucceeded": REQUIRED_TEST_ID in result.success_ids,
    }


def probe_media(path: Path) -> dict:
    completed = subprocess.run(
        ["ffprobe", "-v", "error", "-print_format", "json", "-show_streams", "-show_format", str(path)],
        capture_output=True, text=True, check=False, timeout=30,
    )
    if completed.returncode != 0 or len(completed.stdout) > 1024 * 1024:
        raise AcceptanceFailure("ffprobe did not verify the retained MP4")
    value = json.loads(completed.stdout)
    if not isinstance(value, dict):
        raise AcceptanceFailure("ffprobe returned invalid MP4 metadata")
    return value


def _number(value: object) -> float | None:
    if isinstance(value, bool):
        return None
    try:
        number = float(value)
        return number if math.isfinite(number) else None
    except (TypeError, ValueError, OverflowError):
        return None


def _frame_rate(value: object) -> float | None:
    if not isinstance(value, str):
        return None
    try:
        numerator, denominator = value.split("/")
        divisor = int(denominator)
        return int(numerator) / divisor if divisor else None
    except (ValueError, ZeroDivisionError, OverflowError):
        return None


def validate_evidence(directory: Path) -> dict:
    problems: list[str] = []
    result: dict = {"ok": False, "problems": problems}
    paths = {name: directory / name for name in ARTIFACT_NAMES}
    for name, path in paths.items():
        if path.is_symlink() or not path.is_file() or path.stat().st_size <= 0:
            problems.append(f"Missing, empty or non-regular evidence file: {name}")
    if problems:
        return result
    if paths["voice-proof.json"].stat().st_size > 1024 * 1024:
        problems.append("The font/render evidence JSON exceeds its size limit")
        return result
    try:
        evidence = json.loads(paths["voice-proof.json"].read_text(encoding="utf-8"))
    except (OSError, UnicodeError, ValueError):
        problems.append("The font/render evidence JSON cannot be read")
        return result
    if not isinstance(evidence, dict):
        problems.append("The font/render evidence must be an object")
        return result
    if evidence.get("schema") != EVIDENCE_SCHEMA:
        problems.append("The font/render evidence schema is not current")
    if evidence.get("chineseFontGlyphCoverageVerified") is not True:
        problems.append("Chinese glyph coverage was not verified")
    pixels = evidence.get("bottomRegionWhiteGlyphPixels")
    if type(pixels) is not int or not 300 < pixels <= 1000 * 440:
        problems.append("The actual caption region must contain more than 300 white glyph pixels")
    if evidence.get("aiVoiceQualityVerified") is not False or evidence.get("visualReview") != "pending":
        problems.append("Technical fixtures must not claim AI voice quality or completed human visual review")
    render = evidence.get("renderResult")
    if not isinstance(render, dict):
        problems.append("The renderer result is missing")
        return result
    if render.get("ok") is not True or render.get("profileId") != "local-ffmpeg-voice-v1":
        problems.append("The new measured voice profile did not succeed")
    if render.get("fontFamily") != "Noto Sans CJK SC":
        problems.append("The verified font family must be Noto Sans CJK SC")
    for field in ("fontSha256", "fontSourceSha256"):
        if not isinstance(render.get(field), str) or HASH.fullmatch(render[field]) is None:
            problems.append(f"The renderer must retain the exact {field}")
    face = render.get("fontSourceFaceIndex")
    if type(face) is not int or face < 0:
        problems.append("The renderer must retain a nonnegative integer font source face index")
    if render.get("fontStyleVersion") != "m4-voice-subtitle-style-v1":
        problems.append("The renderer font style version is not current")
    if render.get("videoCodec") != "h264" or render.get("audioCodec") != "aac":
        problems.append("The renderer did not report H.264/AAC")
    if render.get("width") != 1080 or render.get("height") != 1920 or render.get("durationMs") != 2000:
        problems.append("The rendered fixture must be 1080x1920 and 2000 ms")
    try:
        with paths["voice-proof.png"].open("rb") as source:
            header = source.read(24)
        if len(header) != 24 or header[:8] != b"\x89PNG\r\n\x1a\n" or header[12:16] != b"IHDR" or struct.unpack(">II", header[16:24]) != (1080, 1920):
            problems.append("The retained PNG is not a 1080x1920 PNG frame")
        output = paths["voice-output.mp4"]
        size = output.stat().st_size
        if not 0 < size <= MAX_MP4_BYTES or type(render.get("byteSize")) is not int or render["byteSize"] != size:
            problems.append("The retained MP4 size does not match the successful renderer result")
        checksum = hashlib.sha256(output.read_bytes()).hexdigest() if size <= MAX_MP4_BYTES else None
        if render.get("checksumSha256") != checksum:
            problems.append("The retained MP4 checksum does not match the successful renderer result")
        probed = probe_media(output)
        streams = probed.get("streams")
        format_info = probed.get("format")
        if not isinstance(streams, list) or not isinstance(format_info, dict):
            raise AcceptanceFailure("The retained MP4 is missing probed streams or format metadata")
        video = [item for item in streams if isinstance(item, dict) and item.get("codec_type") == "video"]
        audio = [item for item in streams if isinstance(item, dict) and item.get("codec_type") == "audio"]
        if len(streams) != 2 or len(video) != 1 or len(audio) != 1:
            raise AcceptanceFailure("The retained MP4 must contain exactly one video and one audio stream")
        video, audio = video[0], audio[0]
        if video.get("codec_name") != "h264" or video.get("width") != 1080 or video.get("height") != 1920 or video.get("pix_fmt") != "yuv420p":
            problems.append("The actual MP4 video stream is not H.264 1080x1920 yuv420p")
        frame_rate = _frame_rate(video.get("avg_frame_rate"))
        if frame_rate is None or abs(frame_rate - 25) > 0.001:
            problems.append("The actual MP4 video stream is not 25 fps")
        if audio.get("codec_name") != "aac" or str(audio.get("sample_rate")) != "48000" or audio.get("channels") != 2:
            problems.append("The actual MP4 audio stream is not AAC 48 kHz stereo")
        if "mp4" not in str(format_info.get("format_name", "")).split(","):
            problems.append("The retained output is not an MP4 container")
        for name, measured, tolerance in (("video", video.get("duration"), 0.041), ("audio", audio.get("duration"), 0.1), ("container", format_info.get("duration"), 0.1)):
            duration = _number(measured)
            if duration is None or abs(duration - 2) >= tolerance:
                problems.append(f"The actual MP4 {name} duration is not the complete 2-second fixture")
        if _number(format_info.get("size")) != size:
            problems.append("ffprobe's MP4 size does not match the retained bytes")
        result.update({"png": {"width": 1080, "height": 1920, "whiteGlyphPixels": pixels},
                       "font": {key: render.get(key) for key in ("fontFamily", "fontSha256", "fontSourceSha256", "fontSourceFaceIndex", "fontStyleVersion")},
                       "output": {"checksumSha256": checksum, "byteSize": size, "video": video, "audio": audio,
                                  "container": {key: format_info.get(key) for key in ("format_name", "duration", "size")}}})
    except (OSError, ValueError, TypeError, KeyError, subprocess.SubprocessError, AcceptanceFailure) as error:
        problems.append(f"Could not independently verify retained media: {error}")
    result["ok"] = not problems
    return result


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def main(environ: dict[str, str] | None = None, repo_root: Path | None = None, stream: TextIO | None = None) -> int:
    env = os.environ if environ is None else environ
    stream = sys.stderr if stream is None else stream
    repo_root = Path(__file__).resolve().parents[2] if repo_root is None else repo_root
    raw_directory = env.get("VOICE_COMPOSE_TEST_EVIDENCE_DIR", "")
    directory = Path(raw_directory)
    if not raw_directory or not directory.is_absolute():
        print("VOICE_COMPOSE_TEST_EVIDENCE_DIR must be an explicit absolute evidence directory", file=stream)
        return 2
    summary: dict = {"schema": SUMMARY_SCHEMA, "ok": False, "startedAt": _now(), "requiredTestId": REQUIRED_TEST_ID,
                     "testModule": "services/media-worker/tests/test_voice_compose.py", "tests": None,
                     "evidence": {"ok": False, "problems": []}, "problems": []}
    try:
        if directory.is_symlink():
            raise AcceptanceFailure("The evidence directory cannot be a symlink")
        directory.mkdir(parents=True, exist_ok=True)
        if any((directory / name).exists() or (directory / name).is_symlink() for name in ARTIFACT_NAMES):
            raise AcceptanceFailure("Evidence files already exist; provide a new directory so stale artifacts cannot pass")
        # The committed test writes evidence through this operator-owned variable.
        previous = os.environ.get("VOICE_COMPOSE_TEST_EVIDENCE_DIR")
        os.environ["VOICE_COMPOSE_TEST_EVIDENCE_DIR"] = str(directory)
        try:
            result = execute_tests(repo_root, stream)
        finally:
            if previous is None:
                os.environ.pop("VOICE_COMPOSE_TEST_EVIDENCE_DIR", None)
            else:
                os.environ["VOICE_COMPOSE_TEST_EVIDENCE_DIR"] = previous
        details = result_details(result)
        summary["tests"] = details
        if not details["requiredTestSucceeded"]:
            summary["problems"].append("The required real Chinese caption rendering test did not succeed")
        if details["skipped"]:
            summary["problems"].append("Skipped tests are forbidden for voice composition CI acceptance")
        if not result.wasSuccessful() or details["expectedFailures"] or result.testsRun == 0:
            summary["problems"].append("Every collected voice composition test must succeed")
        summary["evidence"] = validate_evidence(directory)
        if not summary["evidence"]["ok"]:
            summary["problems"].append("The retained CJK render evidence did not pass verification")
        summary["ok"] = not summary["problems"]
    except Exception as error:  # Preserve a summary even for import, fixture or process failures.
        summary["problems"].append(f"Voice composition acceptance failed: {type(error).__name__}: {error}")
    summary["finishedAt"] = _now()
    try:
        directory.mkdir(parents=True, exist_ok=True)
        destination = directory / "test-summary.json"
        temporary = directory / "test-summary.json.tmp"
        if destination.is_symlink() or temporary.is_symlink():
            raise AcceptanceFailure("The summary path cannot be a symlink")
        temporary.write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        temporary.replace(destination)
    except (OSError, AcceptanceFailure) as error:
        print(f"Could not retain voice composition test-summary.json: {error}", file=stream)
        return 2
    print(f"Voice composition acceptance {'passed' if summary['ok'] else 'failed'}; summary: {directory / 'test-summary.json'}", file=stream)
    return 0 if summary["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
