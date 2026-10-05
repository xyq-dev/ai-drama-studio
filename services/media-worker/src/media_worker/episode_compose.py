"""Local episode concat. Reuses the accepted probe, path, and process helpers.

This module does not read PostgreSQL or Redis. It refuses a segment that has
no audio instead of synthesizing a replacement track.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
import time
from pathlib import Path

from media_worker.encode_measurement import measure_local_encode
from media_worker.compose_cli import (
    ComposeFailure,
    _die_with_parent,
    _directory,
    _file,
    _probe,
    _publish,
    _run_tool,
)

PROFILE = {
    "width": 1080,
    "height": 1920,
    "frame_rate": 25,
    "crf": "23",
    "preset": "veryfast",
    "sample_rate": "48000",
    "max_output_bytes": 64 * 1024 * 1024,
    "render_timeout_sec": 300,
    "probe_timeout_sec": 30,
    "max_segments": 30,
}
FRAME_TOLERANCE_SEC = (1 / PROFILE["frame_rate"]) + 0.001


def main(argv: list[str] | None = None) -> int:
    _die_with_parent()
    parser = argparse.ArgumentParser(prog="media-episode-compose")
    parser.add_argument("--input-dir", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args(argv)
    try:
        result = render(Path(args.input_dir), Path(args.output))
    except ComposeFailure as error:
        print(json.dumps({"ok": False, "code": error.code, "retryable": error.retryable, "detail": error.detail[-400:]}), file=sys.stderr)
        return 2 if not error.retryable else 3
    print(json.dumps(result))
    return 0


def render(input_dir: Path, output: Path) -> dict[str, object]:
    started = time.monotonic()
    root = _directory(input_dir)
    plan = json.loads(_file(root, "plan.json").read_text(encoding="utf-8"))
    durations = [int(item) for item in plan["durationMs"]]
    if not durations or len(durations) > PROFILE["max_segments"]:
        raise ComposeFailure("COMPOSE_MEDIA_INVALID", False, "segment count")
    expected_ms = int(plan["totalDurationMs"])
    if expected_ms != sum(durations) or expected_ms <= 0 or expected_ms > 90_000:
        raise ComposeFailure("COMPOSE_MEDIA_INVALID", False, "plan duration")
    segments = [_file(root, f"seg-{index:03d}.mp4") for index in range(len(durations))]
    probed = [_require_segment(_probe(path), duration) for path, duration in zip(segments, durations, strict=True)]
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_name(f"{output.stem}.partial{output.suffix}")
    if temporary.exists() or output.exists():
        raise ComposeFailure("COMPOSE_OUTPUT_CONFLICT", False)
    command = _command(segments, probed, temporary)
    try:
        completed = _run_tool(command, PROFILE["render_timeout_sec"])
    except Exception as error:
        temporary.unlink(missing_ok=True)
        if error.__class__.__name__ == "TimeoutExpired":
            raise ComposeFailure("COMPOSE_RENDER_TIMEOUT", True) from error
        raise ComposeFailure("COMPOSE_RENDER_IO", True) from error
    if completed.returncode != 0:
        temporary.unlink(missing_ok=True)
        raise ComposeFailure("COMPOSE_MEDIA_INVALID", False, completed.stderr.decode("utf-8", errors="replace"))
    expected_sec = expected_ms / 1000
    _publish_episode(temporary, output, expected_sec, started)
    digest = hashlib.sha256(output.read_bytes()).hexdigest()
    final = _probe(output)
    return {
        "ok": True,
        "checksumSha256": digest,
        "byteSize": output.stat().st_size,
        "durationMs": int(round(float(final["duration"]) * 1000)),
        "width": int(final["width"]),
        "height": int(final["height"]),
        "elapsedMs": int((time.monotonic() - started) * 1000),
        "localEncode": measure_local_encode(started),
        "videoCodec": final["videoCodec"],
        "audioCodec": final["audioCodec"],
        "segments": len(segments),
    }


def _require_segment(probed: dict[str, object], duration_ms: int) -> dict[str, object]:
    if probed["videoCodec"] != "h264" or probed["audioCodec"] != "aac" or not probed["audioCodec"]:
        raise ComposeFailure("COMPOSE_MEDIA_INVALID", False, "segment codecs")
    if int(probed["width"]) != PROFILE["width"] or int(probed["height"]) != PROFILE["height"]:
        raise ComposeFailure("COMPOSE_MEDIA_INVALID", False, "segment frame")
    if abs(float(probed["frameRate"]) - PROFILE["frame_rate"]) > 0.01:
        raise ComposeFailure("COMPOSE_MEDIA_INVALID", False, "segment fps")
    actual = float(probed["duration"])
    if abs(actual - (duration_ms / 1000)) > FRAME_TOLERANCE_SEC:
        raise ComposeFailure("COMPOSE_MEDIA_INVALID", False, f"segment duration {actual}")
    return probed


def _command(segments: list[Path], probed: list[dict[str, object]], output: Path) -> list[str]:
    inputs: list[str] = []
    filters: list[str] = []
    pairs: list[str] = []
    for index, (path, info) in enumerate(zip(segments, probed, strict=True)):
        duration = float(info["duration"])
        inputs.extend(["-threads", "2", "-i", str(path)])
        filters.append(f"[{index}:v]setpts=PTS-STARTPTS,fps={PROFILE['frame_rate']},setsar=1[v{index}]")
        filters.append(
            f"[{index}:a]aformat=sample_fmts=fltp:sample_rates={PROFILE['sample_rate']}:channel_layouts=stereo,"
            f"atrim=0:{duration:.6f},asetpts=PTS-STARTPTS,apad=whole_dur={duration:.6f},atrim=0:{duration:.6f}[a{index}]"
        )
        pairs.append(f"[v{index}][a{index}]")
    filters.append(f"{''.join(pairs)}concat=n={len(segments)}:v=1:a=1[v][a]")
    return [
        "ffmpeg", "-hide_banner", "-nostdin", "-y",
        "-protocol_whitelist", "file,crypto,data",
        "-filter_threads", "2",
        "-filter_complex_threads", "2",
        *inputs,
        "-filter_complex", ";".join(filters),
        "-map", "[v]", "-map", "[a]",
        "-c:v", "libx264", "-x264-params", "threads=2", "-pix_fmt", "yuv420p",
        "-crf", PROFILE["crf"], "-preset", PROFILE["preset"],
        "-r", str(PROFILE["frame_rate"]),
        "-c:a", "aac", "-ar", PROFILE["sample_rate"], "-ac", "2",
        "-movflags", "+faststart",
        str(output),
    ]


def _publish_episode(temporary: Path, output: Path, expected_sec: float, started: float) -> None:
    if time.monotonic() - started > PROFILE["render_timeout_sec"]:
        temporary.unlink(missing_ok=True)
        raise ComposeFailure("COMPOSE_RENDER_TIMEOUT", True)
    size = temporary.stat().st_size
    if size <= 0 or size > PROFILE["max_output_bytes"]:
        temporary.unlink(missing_ok=True)
        raise ComposeFailure("COMPOSE_OUTPUT_INVALID", False, f"size {size}")
    probed = _probe(temporary)
    if probed["videoCodec"] != "h264" or probed["audioCodec"] != "aac":
        temporary.unlink(missing_ok=True)
        raise ComposeFailure("COMPOSE_OUTPUT_INVALID", False, "output codecs")
    if int(probed["width"]) != PROFILE["width"] or int(probed["height"]) != PROFILE["height"]:
        temporary.unlink(missing_ok=True)
        raise ComposeFailure("COMPOSE_OUTPUT_INVALID", False, "output frame")
    if abs(float(probed["frameRate"]) - PROFILE["frame_rate"]) > 0.01:
        temporary.unlink(missing_ok=True)
        raise ComposeFailure("COMPOSE_OUTPUT_INVALID", False, "output fps")
    actual = float(probed["duration"])
    if abs(actual - expected_sec) > FRAME_TOLERANCE_SEC:
        temporary.unlink(missing_ok=True)
        raise ComposeFailure("COMPOSE_OUTPUT_INVALID", False, f"duration {actual} expected {expected_sec}")
    if abs(float(probed["containerDuration"]) - expected_sec) > 0.1:
        temporary.unlink(missing_ok=True)
        raise ComposeFailure("COMPOSE_OUTPUT_INVALID", False, f"container {probed['containerDuration']}")
    decode = _run_tool(
        ["ffmpeg", "-hide_banner", "-nostdin", "-threads", "2", "-v", "error", "-xerror", "-i", str(temporary), "-f", "null", "-"],
        PROFILE["render_timeout_sec"],
    )
    if decode.returncode != 0:
        temporary.unlink(missing_ok=True)
        raise ComposeFailure("COMPOSE_OUTPUT_INVALID", False, decode.stderr.decode("utf-8", errors="replace")[-300:])
    _publish(temporary, output, expected_sec, started)


if __name__ == "__main__":
    raise SystemExit(main())
