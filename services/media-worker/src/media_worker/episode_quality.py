"""Measure the published episode, without modifying or retranscoding the delivery."""

from __future__ import annotations

import subprocess
from pathlib import Path

from media_worker.compose_cli import _run_tool
from media_worker.qc_skill_measurements import black_segments, silence_segments

QC_SKILL_VERSION = "1.4.5"
# Keep intentional sub-second fades/pauses out of the list on a normal episode.
MIN_BLACK_SEC = 0.5
MIN_SILENCE_SEC = 1.0
MAX_FINDINGS = 64
SCAN_TIMEOUT_SEC = 90


def check_episode(path: Path, duration_ms: int, *, video_present: bool, audio_present: bool) -> dict:
    report = {"skill": "qc-skill", "version": QC_SKILL_VERSION, "status": "UNKNOWN", "findings": []}
    missing = []
    if not video_present:
        missing.append({"code": "NO_VIDEO"})
    if not audio_present:
        missing.append({"code": "NO_AUDIO"})
    if missing:
        return {**report, "status": "FAIL", "findings": missing}
    if duration_ms <= 0:
        return {**report, "reason": "INCOMPLETE"}

    # A short sample entirely black/silent should still be visible in the report.
    half_duration = duration_ms / 2000
    black_sec = min(MIN_BLACK_SEC, half_duration)
    silence_sec = min(MIN_SILENCE_SEC, half_duration)
    try:
        scan = _run_tool([
            "ffmpeg", "-hide_banner", "-nostdin", "-nostats", "-xerror", "-loglevel", "info",
            "-progress", "pipe:1", "-threads", "2", "-filter_threads", "2",
            "-protocol_whitelist", "file", "-i", str(path),
            "-map", "0:v:0", "-map", "0:a:0",
            "-vf", f"blackdetect=d={black_sec}:pix_th=0.10",
            "-af", f"silencedetect=n=-50dB:d={silence_sec}",
            "-f", "null", "-",
        ], SCAN_TIMEOUT_SEC)
    except (OSError, subprocess.TimeoutExpired):
        return {**report, "reason": "CHECK_UNAVAILABLE"}
    if scan.returncode != 0 or b"progress=end" not in scan.stdout.splitlines():
        return {**report, "reason": "INCOMPLETE"}

    stderr = scan.stderr.decode("utf-8", errors="replace")
    findings = []
    for code, spans in (("BLACK", black_segments(stderr)), ("SILENCE", silence_segments(stderr, duration_ms / 1000))):
        for span in spans:
            start = max(0, min(duration_ms, round(span["start"] * 1000)))
            end = max(start, min(duration_ms, round(span["end"] * 1000)))
            if end > start:
                findings.append({"code": code, "startMs": start, "endMs": end})
    findings.sort(key=lambda item: (item["startMs"], item["code"]))
    return {**report, "status": "FAIL" if findings else "PASS", "findings": findings[:MAX_FINDINGS]}
